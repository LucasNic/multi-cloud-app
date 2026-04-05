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

  if (event.action === "handle_request" || event.action === "handle_async" || event.action === "simulate_failure") {
    totalRequests++;
  }
  if (event.status === "error") {
    totalErrors++;
  }

  updateMetrics();
  addTraceToList(event.trace_id, event.action, event.status === "error");
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
  } catch {
    const badge = document.getElementById("cluster-name");
    if (badge) {
      badge.textContent = "unreachable";
      badge.style.color = "#ef4444";
    }
  }
}

updateClusterInfo();
setInterval(updateClusterInfo, 10_000);

// --- Button handlers with loading state ---
function setupButton(id: string, endpoint: string): void {
  const btn = document.getElementById(id);
  if (!btn) return;

  btn.addEventListener("click", async () => {
    btn.classList.add("loading");
    try {
      await fetch(`${BACKEND_URL}${endpoint}`, { method: "POST" });
    } catch (e) {
      console.error(`[${id}] request failed`, e);
    } finally {
      setTimeout(() => btn.classList.remove("loading"), 400);
    }
  });
}

setupButton("btn-request", "/api/request");
setupButton("btn-async", "/api/async");
setupButton("btn-fail", "/api/fail");

// --- Trace list ---
const activeTraces = new Set<string>();

function addTraceToList(traceId: string, action: string, isError: boolean): void {
  if (activeTraces.has(traceId)) return;
  activeTraces.add(traceId);

  const list = document.getElementById("trace-list");
  if (!list) return;

  const li = document.createElement("li");
  if (isError) li.classList.add("error");

  li.innerHTML = `
    <span class="trace-dot"></span>
    <span class="trace-id">${traceId}</span>
    <span class="trace-action">${action}</span>
  `;
  li.title = traceId;
  list.prepend(li);

  // Keep list short
  while (list.children.length > 15) {
    list.removeChild(list.lastChild!);
  }

  // Update count
  const count = document.getElementById("trace-count");
  if (count) count.textContent = `${activeTraces.size} traces`;
}
