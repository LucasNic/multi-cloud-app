// Graph node definitions — dual-cluster architecture topology.
// Shows both AKS (primary) and GKE (failover) paths.

export interface Node {
  id: string;
  label: string;
  x: number;
  y: number;
  state: "idle" | "processing" | "success" | "error" | "down";
}

export interface Edge {
  id: string;
  source: string;
  target: string;
  state: "idle" | "active" | "error";
}

// Dual-cluster layout:
//
//   User → Cloudflare ──→ AKS API ──→ CockroachDB
//                    └──→ GKE API ──↗
//                         AKS API ──→ Queue → Worker
//
export const NODES: Node[] = [
  { id: "user",      label: "User",                    x: 60,  y: 180, state: "idle" },
  { id: "cdn",       label: "CDN (Cloudflare)",        x: 210, y: 180, state: "idle" },
  { id: "aks-api",   label: "K8s API (Azure AKS)",     x: 410, y: 110, state: "idle" },
  { id: "gke-api",   label: "K8s API (GCP GKE)",       x: 410, y: 250, state: "idle" },
  { id: "db",        label: "PostgreSQL (CockroachDB)", x: 620, y: 180, state: "idle" },
  { id: "queue",     label: "In-Memory Queue",          x: 620, y: 60,  state: "idle" },
  { id: "worker",    label: "Async Worker (Go)",        x: 790, y: 60,  state: "idle" },
];

export const EDGES: Edge[] = [
  { id: "user-cdn",      source: "user",    target: "cdn",     state: "idle" },
  { id: "cdn-aks",       source: "cdn",     target: "aks-api", state: "idle" },
  { id: "cdn-gke",       source: "cdn",     target: "gke-api", state: "idle" },
  { id: "aks-db",        source: "aks-api", target: "db",      state: "idle" },
  { id: "gke-db",        source: "gke-api", target: "db",      state: "idle" },
  { id: "aks-queue",     source: "aks-api", target: "queue",   state: "idle" },
  { id: "queue-worker",  source: "queue",   target: "worker",  state: "idle" },
  { id: "worker-db",     source: "worker",  target: "db",      state: "idle" },
];

// Maps OTel span actions → edges (uses active cluster prefix)
// Returns an array because some actions activate multiple edges (e.g. user-cdn + cdn-aks)
export function getEdgesForAction(action: string, activeCluster: string): string[] {
  const prefix = activeCluster === "primary" ? "aks" : "gke";
  const map: Record<string, string[]> = {
    "handle_request":   ["user-cdn", `cdn-${prefix}`],
    "db.query":         [`${prefix}-db`],
    "db.write":         ["worker-db"],
    "handle_async":     ["user-cdn", `cdn-${prefix}`],
    "queue.enqueue":    [`${prefix}-queue`],
    "worker.process":   ["queue-worker"],
  };
  return map[action] ?? [];
}

// Backwards-compat single-edge accessor (returns first edge)
export function getEdgeForAction(action: string, activeCluster: string): string | undefined {
  return getEdgesForAction(action, activeCluster)[0];
}

// Maps OTel span actions → nodes (uses active cluster prefix)
export function getNodeForAction(action: string, activeCluster: string): string | undefined {
  const prefix = activeCluster === "primary" ? "aks-api" : "gke-api";
  const map: Record<string, string> = {
    "handle_request":   prefix,
    "db.query":         "db",
    "db.write":         "db",
    "handle_async":     prefix,
    "queue.enqueue":    "queue",
    "worker.process":   "worker",
  };
  return map[action];
}

export interface SpanSnapshot {
  action: string;
  status: "processing" | "success" | "error";
  duration_ms: number;
  cluster: string;
  timestamp: number;
}
