import { TraceStream } from "./ws/stream";
import { GraphRenderer } from "./graph/renderer";
import { ACTION_TO_EDGE, ACTION_TO_NODE } from "./graph/nodes";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8080";
const STREAMER_WS  = import.meta.env.VITE_STREAMER_WS_URL ?? "ws://localhost:8081/ws";

// --- Graph ---
const graph = new GraphRenderer("#graph");

// --- WebSocket stream ---
const stream = new TraceStream(STREAMER_WS);

stream.onEvent((event) => {
  const nodeId = ACTION_TO_NODE[event.action];
  const edgeId = ACTION_TO_EDGE[event.action];

  const nodeState = event.status === "error" ? "error"
    : event.duration_ms > 0 ? "success"
    : "processing";

  if (nodeId) graph.setNodeState(nodeId, nodeState);
  if (edgeId) graph.setEdgeState(edgeId, event.status === "error" ? "error" : "active");

  addTraceToList(event.trace_id);
});

stream.connect();

// --- Cluster info ---
async function updateClusterInfo() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/cluster`);
    const data = await res.json();
    const badge = document.getElementById("cluster-name");
    if (badge) {
      badge.textContent = data.cluster ?? "unknown";
      badge.style.color = data.cluster === "oci" ? "#3fb950" : "#388bfd";
    }
    graph.setCluster(data.cluster);
  } catch {
    const badge = document.getElementById("cluster-name");
    if (badge) badge.textContent = "unreachable";
  }
}

updateClusterInfo();
setInterval(updateClusterInfo, 10_000);

// --- Buttons ---
document.getElementById("btn-request")?.addEventListener("click", async () => {
  await fetch(`${BACKEND_URL}/api/request`, { method: "POST" });
});

document.getElementById("btn-async")?.addEventListener("click", async () => {
  await fetch(`${BACKEND_URL}/api/async`, { method: "POST" });
});

document.getElementById("btn-fail")?.addEventListener("click", async () => {
  await fetch(`${BACKEND_URL}/api/fail`, { method: "POST" });
});

// --- Trace list ---
const activeTraces = new Set<string>();

function addTraceToList(traceId: string): void {
  if (activeTraces.has(traceId)) return;
  activeTraces.add(traceId);

  const list = document.getElementById("trace-list");
  if (!list) return;

  const li = document.createElement("li");
  li.textContent = traceId.slice(0, 16) + "...";
  li.title = traceId;
  list.prepend(li);

  // Keep list short
  while (list.children.length > 10) {
    list.removeChild(list.lastChild!);
  }
}
