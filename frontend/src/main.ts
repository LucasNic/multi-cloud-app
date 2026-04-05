import { TraceStream } from "./ws/stream";
import { GraphRenderer } from "./graph/renderer";
import { ACTION_TO_EDGE, ACTION_TO_NODE } from "./graph/nodes";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8080";
const STREAMER_WS  = import.meta.env.VITE_STREAMER_WS_URL ?? "ws://localhost:8081/ws";

// --- Metrics state ---
let totalRequests = 0;
let totalErrors = 0;
let totalSpans = 0;
let latencies: number[] = [];

function updateMetrics(): void {
  const el = (id: string) => document.getElementById(id);
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

// Patch stream to track connection status
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

// Ignore health/readiness spans to keep UI clean
const IGNORE_ACTIONS = new Set(["/healthz", "/readyz", "/livez", "/health"]);

// Track per-trace latency info (first request span → total latency)
const traceLatency = new Map<string, number>();

stream.onEvent((event) => {
  // Skip k8s probe noise
  if (IGNORE_ACTIONS.has(event.action)) return;

  const nodeId = ACTION_TO_NODE[event.action];
  const edgeId = ACTION_TO_EDGE[event.action];

  const nodeState = event.status === "error" ? "error"
    : event.duration_ms > 0 ? "success"
    : "processing";

  if (nodeId) graph.setNodeState(nodeId, nodeState);
  if (edgeId) graph.setEdgeState(edgeId, event.status === "error" ? "error" : "active");

  // Update metrics
  totalSpans++;
  if (event.duration_ms > 0) latencies.push(event.duration_ms);
  if (latencies.length > 100) latencies = latencies.slice(-100);

  // Track per-trace latency from the root span
  const isRootAction = event.action === "handle_request" || event.action === "handle_async" || event.action === "simulate_failure";
  if (isRootAction) {
    totalRequests++;
    if (event.duration_ms > 0) {
      traceLatency.set(event.trace_id, event.duration_ms);
    }
  }
  if (event.status === "error") {
    totalErrors++;
  }

  updateMetrics();
  addTraceToList(event.trace_id, event.action, event.status === "error", event.duration_ms);
});

stream.connect();

// --- Cluster info ---
async function updateClusterInfo(): Promise<void> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/cluster`);
    const data = await res.json();
    const badge = document.getElementById("cluster-name");
    if (badge) {
      const cluster = data.cluster || "unknown";
      const cloud = data.cloud || "";
      badge.textContent = cloud ? `${cluster} (${cloud})` : cluster;
      badge.style.color = cloud === "azure" ? "#3b82f6" : cloud === "gcp" ? "#22c55e" : "#f1f5f9";
    }
    graph.setCluster(data.cluster);
    updateFailoverUI(data.healthy !== false);
  } catch {
    const badge = document.getElementById("cluster-name");
    if (badge) {
      badge.textContent = "unreachable";
      badge.style.color = "#ef4444";
    }
    updateFailoverUI(false);
  }
}

updateClusterInfo();
setInterval(updateClusterInfo, 5_000);

// --- Failover control ---
function updateFailoverUI(healthy: boolean): void {
  const azureDot = document.getElementById("azure-dot");
  const btnRecover = document.getElementById("btn-recover");
  const failoverInfo = document.getElementById("failover-info");
  const btnDown = document.getElementById("btn-down-azure") as HTMLButtonElement;

  if (azureDot) {
    azureDot.className = healthy ? "cluster-dot healthy" : "cluster-dot unhealthy";
  }
  if (btnRecover) {
    btnRecover.style.display = healthy ? "none" : "flex";
  }
  if (failoverInfo) {
    failoverInfo.style.display = healthy ? "none" : "block";
  }
  if (btnDown) {
    btnDown.textContent = healthy ? "Simulate Down" : "Down (simulated)";
    btnDown.disabled = !healthy;
  }
}

document.getElementById("btn-down-azure")?.addEventListener("click", async () => {
  const btn = document.getElementById("btn-down-azure") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Triggering...";

  try {
    const res = await fetch(`${BACKEND_URL}/api/simulate-down`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duration_sec: 300 }),
    });
    const data = await res.json();

    const infoStatus = document.getElementById("failover-info-status");
    const infoRecovery = document.getElementById("failover-info-recovery");
    if (infoStatus) infoStatus.textContent = "Simulated outage active";
    if (infoRecovery && data.recovers_at) {
      const t = new Date(data.recovers_at);
      infoRecovery.textContent = t.toLocaleTimeString();
    }

    updateFailoverUI(false);
  } catch (e) {
    console.error("simulate-down failed", e);
    btn.disabled = false;
    btn.textContent = "Simulate Down";
  }
});

document.getElementById("btn-recover")?.addEventListener("click", async () => {
  try {
    await fetch(`${BACKEND_URL}/api/simulate-recover`, { method: "POST" });
    updateFailoverUI(true);
  } catch (e) {
    console.error("simulate-recover failed", e);
  }
});

// --- Button handlers with loading state and latency measurement ---
function setupButton(id: string, endpoint: string): void {
  const btn = document.getElementById(id);
  if (!btn) return;

  btn.addEventListener("click", async () => {
    btn.classList.add("loading");
    const start = performance.now();
    try {
      const res = await fetch(`${BACKEND_URL}${endpoint}`, { method: "POST" });
      const elapsed = Math.round(performance.now() - start);
      const data = await res.json();

      // Flash the latency on the button
      const origText = btn.textContent;
      btn.textContent = `${elapsed}ms`;
      btn.classList.remove("loading");
      btn.classList.add("latency-flash");
      setTimeout(() => {
        btn.textContent = origText;
        btn.classList.remove("latency-flash");
      }, 1200);

      // Store client-side E2E latency
      if (data.trace_id) {
        traceLatency.set(data.trace_id, elapsed);
        updateTraceLatency(data.trace_id, elapsed);
      }
    } catch (e) {
      console.error(`[${id}] request failed`, e);
      btn.classList.remove("loading");
    }
  });
}

setupButton("btn-request", "/api/request");
setupButton("btn-async", "/api/async");
setupButton("btn-fail", "/api/fail");

// --- Trace list ---
const activeTraces = new Set<string>();

function addTraceToList(traceId: string, action: string, isError: boolean, durationMs: number): void {
  if (activeTraces.has(traceId)) return;
  activeTraces.add(traceId);

  const list = document.getElementById("trace-list");
  if (!list) return;

  // Use stored client E2E latency if available, otherwise span duration
  const latency = traceLatency.get(traceId) ?? durationMs;
  const latencyText = latency > 0 ? `${Math.round(latency)}ms` : "...";

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

  // Keep list short
  while (list.children.length > 20) {
    list.removeChild(list.lastChild!);
  }

  // Update count
  const count = document.getElementById("trace-count");
  if (count) count.textContent = `${activeTraces.size} traces`;
}

function updateTraceLatency(traceId: string, latencyMs: number): void {
  const li = document.getElementById(`trace-${traceId}`);
  if (!li) return;
  const latencyEl = li.querySelector(".trace-latency");
  if (latencyEl) {
    latencyEl.textContent = `${Math.round(latencyMs)}ms`;
    latencyEl.classList.add("latency-updated");
  }
}
