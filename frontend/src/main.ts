import { TraceStream } from "./ws/stream";
import { GraphRenderer } from "./graph/renderer";
import { getEdgesForAction, getNodeForAction, type SpanSnapshot } from "./graph/nodes";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8080";
const STREAMER_WS  = import.meta.env.VITE_STREAMER_WS_URL ?? "ws://localhost:8081/ws";

// --- State ---
let totalRequests = 0;
let totalErrors = 0;
let totalSpans = 0;
let latencies: number[] = [];
let activeCluster = "primary"; // "primary" = aks, "secondary" = gke
// clusterIsDown state is managed by updateFailoverUI

interface RequestRecord {
  timestamp: Date;
  type: string;
  traceId: string;
  latencyMs: number;
  status: "success" | "error";
  cluster: string;
  error?: string;
}
const requestHistory: RequestRecord[] = [];

// Accumulates all spans per trace_id so we can replay the full path on the graph
const traceSpans = new Map<string, SpanSnapshot[]>();
let selectedTraceId: string | null = null;

function el(id: string): HTMLElement | null { return document.getElementById(id); }

function updateMetrics(): void {
  el("metric-requests")!.textContent = totalRequests.toLocaleString();
  el("metric-errors")!.textContent = totalErrors.toLocaleString();
  el("metric-spans")!.textContent = totalSpans.toLocaleString();

  if (latencies.length > 0) {
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    el("metric-latency")!.textContent = avg < 1 ? "<1ms" : `${Math.round(avg)}ms`;
  }
}

// --- Graph ---
const graph = new GraphRenderer("#graph");

// --- WebSocket stream ---
const stream = new TraceStream(STREAMER_WS);
const wsStatus = document.getElementById("ws-status")!;
const wsText = wsStatus.querySelector(".status-text")!;

const origConnect = stream.connect.bind(stream);
stream.connect = function () {
  origConnect();
  const ws = (stream as unknown as { ws: WebSocket }).ws;
  if (ws) {
    ws.addEventListener("open", () => {
      wsStatus.className = "status-pill connected";
      wsText.textContent = "Stream connected";
    });
    ws.addEventListener("close", () => {
      wsStatus.className = "status-pill disconnected";
      wsText.textContent = "Reconnecting...";
    });
  }
};

const IGNORE_ACTIONS = new Set(["/healthz", "/readyz", "/livez", "/health"]);

stream.onEvent((event) => {
  if (IGNORE_ACTIONS.has(event.action)) return;

  // Accumulate span into trace buffer
  const snap: SpanSnapshot = {
    action: event.action,
    status: event.status,
    duration_ms: event.duration_ms,
    cluster: event.cluster || activeCluster,
    timestamp: event.timestamp,
  };
  if (!traceSpans.has(event.trace_id)) traceSpans.set(event.trace_id, []);
  traceSpans.get(event.trace_id)!.push(snap);
  // Keep map from growing unbounded (keep last 100 traces)
  if (traceSpans.size > 100) {
    const oldest = traceSpans.keys().next().value;
    if (oldest) traceSpans.delete(oldest);
  }

  // Only animate live spans when no trace is pinned
  if (!graph.isHighlightPersisted()) {
    const nodeId = getNodeForAction(event.action, activeCluster);
    const edgeIds = getEdgesForAction(event.action, activeCluster);
    const nodeState = event.status === "error" ? "error"
      : event.duration_ms > 0 ? "success"
      : "processing";

    if (nodeId) graph.setNodeState(nodeId, nodeState);
    const latencyForEdge = event.duration_ms > 0 ? event.duration_ms : undefined;
    edgeIds.forEach((edgeId, idx) => {
      // Only show latency on the last edge (the backend hop)
      graph.setEdgeState(edgeId, event.status === "error" ? "error" : "active",
        idx === edgeIds.length - 1 ? latencyForEdge : undefined);
    });
  }

  totalSpans++;
  if (event.duration_ms > 0) latencies.push(event.duration_ms);
  if (latencies.length > 100) latencies = latencies.slice(-100);

  const isRootAction = event.action === "handle_request" || event.action === "handle_async";
  if (isRootAction) totalRequests++;
  if (event.status === "error") totalErrors++;

  updateMetrics();
  addTraceToList(event.trace_id, event.action, event.status === "error", event.duration_ms);
});

stream.connect();

// --- Cluster info ---
interface ClusterState {
  name: string;
  is_down: boolean;
}

interface ClusterResponse {
  cluster: string;
  cloud: string;
  healthy: boolean;
  all_clusters: ClusterState[];
}

async function updateClusterInfo(): Promise<void> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/cluster`);
    const data: ClusterResponse = await res.json();
    const badge = el("cluster-name");
    if (badge) {
      const cluster = data.cluster || "unknown";
      const cloud = data.cloud || "";
      badge.textContent = cloud ? `${cluster} (${cloud})` : cluster;
      badge.style.color = cloud === "azure" ? "#3b82f6" : cloud === "gcp" ? "#22c55e" : "#f1f5f9";
    }
    activeCluster = data.cluster || "primary";
    updateFailoverUI(data);
  } catch {
    const badge = el("cluster-name");
    if (badge) {
      badge.textContent = "unreachable";
      badge.style.color = "#ef4444";
    }
  }
}

updateClusterInfo();
setInterval(updateClusterInfo, 3_000);

// --- Failover UI ---
function updateFailoverUI(data: ClusterResponse): void {
  const servingCloud = data.cloud || "azure";
  const allClusters = data.all_clusters || [];

  const azureState = allClusters.find(c => c.name === "primary");

  const azureDown = azureState?.is_down ?? false;
  const isServingFromGke = servingCloud === "gcp";
  const isServingFromAzure = !isServingFromGke;

  // DOM refs
  const azureDot = el("azure-dot");
  const azureRole = el("azure-role");
  const btnAzure = el("btn-down-azure") as HTMLButtonElement | null;
  const gcpDot = el("gcp-dot");
  const gcpRole = el("gcp-role");
  const btnGcp = el("btn-down-gcp") as HTMLButtonElement | null;
  const failoverInfo = el("failover-info");

  // Graph: dim the cluster NOT serving traffic
  graph.setClusterDown("aks-api", isServingFromGke);
  graph.setClusterDown("gke-api", isServingFromAzure);

  // --- Azure Row ---
  if (isServingFromAzure && !azureDown) {
    // Normal: Azure is primary and healthy
    if (azureDot) azureDot.className = "cluster-dot healthy";
    if (azureRole) { azureRole.textContent = "primary"; azureRole.className = "cluster-role-tag"; }
    if (btnAzure) {
      btnAzure.textContent = "Simulate Down";
      btnAzure.disabled = false;
      btnAzure.className = "btn-small btn-small-danger";
      btnAzure.dataset.action = "simulate-down";
    }
  } else if (azureDown) {
    // Azure is down
    if (azureDot) azureDot.className = "cluster-dot unhealthy";
    if (azureRole) { azureRole.textContent = "down"; azureRole.className = "cluster-role-tag danger"; }
    if (btnAzure) {
      btnAzure.textContent = "Recover";
      btnAzure.disabled = false;
      btnAzure.className = "btn-small btn-small-recover";
      btnAzure.dataset.action = "recover";
    }
  } else {
    // Azure healthy but GCP is serving → standby
    if (azureDot) azureDot.className = "cluster-dot standby";
    if (azureRole) { azureRole.textContent = "standby"; azureRole.className = "cluster-role-tag secondary"; }
    if (btnAzure) {
      btnAzure.textContent = "Set as Primary";
      btnAzure.disabled = false;
      btnAzure.className = "btn-small btn-small-primary";
      btnAzure.dataset.action = "set-primary-azure";
    }
  }

  // --- GCP Row ---
  if (isServingFromGke) {
    // GCP is serving
    if (gcpDot) gcpDot.className = "cluster-dot healthy";
    if (gcpRole) { gcpRole.textContent = "primary"; gcpRole.className = "cluster-role-tag"; }
    if (btnGcp) {
      btnGcp.textContent = "Serving";
      btnGcp.disabled = true;
      btnGcp.className = "btn-small btn-small-muted";
      btnGcp.dataset.action = "";
    }
  } else if (isServingFromAzure && !azureDown) {
    // Azure is primary → GCP is standby, offer "Set as Primary"
    if (gcpDot) gcpDot.className = "cluster-dot standby";
    if (gcpRole) { gcpRole.textContent = "standby"; gcpRole.className = "cluster-role-tag secondary"; }
    if (btnGcp) {
      btnGcp.textContent = "Set as Primary";
      btnGcp.disabled = false;
      btnGcp.className = "btn-small btn-small-primary";
      btnGcp.dataset.action = "set-primary-gcp";
    }
  } else {
    // Transitioning
    if (gcpDot) gcpDot.className = "cluster-dot standby";
    if (gcpRole) { gcpRole.textContent = "standby"; gcpRole.className = "cluster-role-tag secondary"; }
    if (btnGcp) {
      btnGcp.textContent = "Standby";
      btnGcp.disabled = true;
      btnGcp.className = "btn-small btn-small-muted";
      btnGcp.dataset.action = "";
    }
  }

  // --- Failover Info ---
  if (isServingFromGke && azureDown) {
    if (failoverInfo) {
      failoverInfo.style.display = "block";
      const infoStatus = el("failover-info-status");
      if (infoStatus) infoStatus.textContent = "Azure AKS is down — GKE serving traffic";
    }
  } else if (isServingFromGke && !azureDown) {
    if (failoverInfo) {
      failoverInfo.style.display = "block";
      const infoStatus = el("failover-info-status");
      if (infoStatus) infoStatus.textContent = "GKE is primary — Azure on standby";
    }
  } else {
    if (failoverInfo) failoverInfo.style.display = "none";
  }
}

// --- Azure button handler (dynamic action) ---
el("btn-down-azure")?.addEventListener("click", async () => {
  const btn = el("btn-down-azure") as HTMLButtonElement;
  const action = btn.dataset.action;
  if (!action) return;

  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = "Processing...";

  try {
    if (action === "simulate-down") {
      const res = await fetch(`${BACKEND_URL}/api/simulate-down`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duration_sec: 300 }),
      });
      const data = await res.json();
      const infoStatus = el("failover-info-status");
      const infoRecovery = el("failover-info-recovery");
      if (infoStatus) infoStatus.textContent = "Failover triggered — switching to GKE...";
      if (infoRecovery && data.recovers_at) {
        infoRecovery.textContent = new Date(data.recovers_at).toLocaleTimeString();
      }
      const failoverInfo = el("failover-info");
      if (failoverInfo) failoverInfo.style.display = "block";
    } else if (action === "recover" || action === "set-primary-azure") {
      await fetch(`${BACKEND_URL}/api/trigger-recovery`, { method: "POST" });
    }
    setTimeout(updateClusterInfo, 2000);
  } catch (e) {
    console.error("azure action failed", e);
    btn.disabled = false;
    btn.textContent = origText;
  }
});

// --- GCP button handler (dynamic action) ---
el("btn-down-gcp")?.addEventListener("click", async () => {
  const btn = el("btn-down-gcp") as HTMLButtonElement;
  const action = btn.dataset.action;
  if (!action) return;

  btn.disabled = true;
  btn.textContent = "Processing...";

  try {
    if (action === "set-primary-gcp") {
      await fetch(`${BACKEND_URL}/api/simulate-down`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duration_sec: 300 }),
      });
      const failoverInfo = el("failover-info");
      const infoStatus = el("failover-info-status");
      if (failoverInfo) failoverInfo.style.display = "block";
      if (infoStatus) infoStatus.textContent = "Switching primary to GKE...";
    }
    setTimeout(updateClusterInfo, 2000);
  } catch (e) {
    console.error("gcp action failed", e);
    btn.disabled = false;
    btn.textContent = "Set as Primary";
  }
});

// --- Button handlers ---
function setupButton(id: string, endpoint: string, actionType: string): void {
  const btn = el(id);
  if (!btn) return;

  btn.addEventListener("click", async () => {
    btn.classList.add("loading");
    const start = performance.now();
    let record: RequestRecord;

    try {
      const res = await fetch(`${BACKEND_URL}${endpoint}`, { method: "POST" });
      const elapsed = Math.round(performance.now() - start);
      const data = await res.json();
      const isError = !res.ok;

      record = {
        timestamp: new Date(),
        type: actionType,
        traceId: data.trace_id || "—",
        latencyMs: elapsed,
        status: isError ? "error" : "success",
        cluster: data.cluster || activeCluster,
        error: isError ? (data.error || `HTTP ${res.status}`) : undefined,
      };

      // Flash latency on button
      const origHTML = btn.innerHTML;
      btn.textContent = isError ? `ERROR ${elapsed}ms` : `${elapsed}ms`;
      btn.classList.remove("loading");
      btn.classList.add(isError ? "latency-flash-error" : "latency-flash");
      setTimeout(() => {
        btn.innerHTML = origHTML;
        btn.classList.remove("latency-flash", "latency-flash-error");
      }, 1200);

    } catch (e) {
      const elapsed = Math.round(performance.now() - start);
      record = {
        timestamp: new Date(),
        type: actionType,
        traceId: "—",
        latencyMs: elapsed,
        status: "error",
        cluster: activeCluster,
        error: "Network error",
      };
      btn.classList.remove("loading");
    }

    // Add to history
    requestHistory.unshift(record);
    if (requestHistory.length > 50) requestHistory.pop();
    renderRequestHistory();
  });
}

setupButton("btn-request", "/api/request", "Standard");
setupButton("btn-async", "/api/async", "Async");

// --- Trace list ---
const activeTraces = new Set<string>();

function addTraceToList(traceId: string, action: string, isError: boolean, durationMs: number): void {
  if (activeTraces.has(traceId)) return;
  activeTraces.add(traceId);

  const list = el("trace-list");
  if (!list) return;

  const latencyText = durationMs > 0 ? `${Math.round(durationMs)}ms` : "...";

  const li = document.createElement("li");
  li.id = `trace-${traceId}`;
  if (isError) li.classList.add("error");

  li.innerHTML = `
    <span class="trace-dot"></span>
    <span class="trace-id">${traceId.slice(0, 16)}...</span>
    <span class="trace-action">${action.replace("handle_", "").replace("simulate_", "")}</span>
    <span class="trace-latency">${latencyText}</span>
  `;
  li.title = traceId;
  list.prepend(li);

  while (list.children.length > 20) {
    list.removeChild(list.lastChild!);
  }

  const count = el("trace-count");
  if (count) count.textContent = `${activeTraces.size} traces`;
}

// --- Trace highlight from history ---
function highlightTraceById(traceId: string): void {
  if (traceId === "—") return;
  const spans = traceSpans.get(traceId);
  if (!spans || spans.length === 0) return;

  selectedTraceId = traceId;
  const cluster = spans[0].cluster || activeCluster;
  graph.highlightTrace(spans, cluster, true);
  renderRequestHistory(); // re-render to show selected state
}

function deselectTrace(): void {
  if (!selectedTraceId) return;
  selectedTraceId = null;
  graph.clearHighlight();
  renderRequestHistory();
}

// Click anywhere on the graph canvas to deselect
document.getElementById("graph")?.addEventListener("click", () => {
  if (selectedTraceId) deselectTrace();
});

// --- Request History ---
function renderRequestHistory(): void {
  const tbody = el("request-history-body");
  if (!tbody) return;

  tbody.innerHTML = requestHistory.map((r) => {
    const statusClass = r.status === "error" ? "status-error" : "status-ok";
    const statusText = r.status === "error" ? (r.error || "error") : "ok";
    const time = r.timestamp.toLocaleTimeString();
    const isSelected = r.traceId === selectedTraceId;
    const hasTrace = r.traceId !== "—" && traceSpans.has(r.traceId);
    const rowClass = [
      r.status === "error" ? "row-error" : "",
      isSelected ? "row-selected" : "",
      hasTrace ? "row-clickable" : "",
    ].filter(Boolean).join(" ");
    return `<tr class="${rowClass}" data-trace-id="${r.traceId}">
      <td class="cell-time">${time}</td>
      <td><span class="type-tag type-${r.type.toLowerCase()}">${r.type}</span></td>
      <td class="cell-mono">${r.latencyMs}ms</td>
      <td><span class="status-badge ${statusClass}">${statusText}</span></td>
      <td class="cell-mono cell-trace">${r.traceId === "—" ? "—" : r.traceId.slice(0, 12) + "..."}</td>
    </tr>`;
  }).join("");

  // Attach click handlers to rows
  tbody.querySelectorAll("tr[data-trace-id]").forEach((row) => {
    row.addEventListener("click", () => {
      const traceId = (row as HTMLElement).dataset.traceId || "—";
      if (traceId === selectedTraceId) {
        deselectTrace();
      } else {
        highlightTraceById(traceId);
      }
    });
  });

  const countEl = el("history-count");
  if (countEl) countEl.textContent = `${requestHistory.length} requests`;
}
