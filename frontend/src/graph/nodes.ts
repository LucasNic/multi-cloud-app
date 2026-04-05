// Graph node definitions — each represents a service in the architecture.
// Positions are fixed (not force-directed) for clarity and consistency.

export interface Node {
  id: string;
  label: string;
  x: number;
  y: number;
  state: "idle" | "processing" | "success" | "error";
}

export interface Edge {
  id: string;
  source: string;
  target: string;
  state: "idle" | "active" | "error";
}

// Fixed layout — left to right, branching at API
// Matches the architecture: User → Cloudflare → API → DB / Queue → Worker → DB
export const NODES: Node[] = [
  { id: "user",    label: "User",        x: 60,  y: 140, state: "idle" },
  { id: "cdn",     label: "Cloudflare",  x: 220, y: 140, state: "idle" },
  { id: "api",     label: "API",         x: 400, y: 140, state: "idle" },
  { id: "db",      label: "CockroachDB", x: 600, y: 60,  state: "idle" },
  { id: "queue",   label: "Queue",       x: 600, y: 220, state: "idle" },
  { id: "worker",  label: "Worker",      x: 760, y: 220, state: "idle" },
];

export const EDGES: Edge[] = [
  { id: "user-cdn",    source: "user",   target: "cdn",    state: "idle" },
  { id: "cdn-api",     source: "cdn",    target: "api",    state: "idle" },
  { id: "api-db",      source: "api",    target: "db",     state: "idle" },
  { id: "api-queue",   source: "api",    target: "queue",  state: "idle" },
  { id: "queue-worker",source: "queue",  target: "worker", state: "idle" },
  { id: "worker-db",   source: "worker", target: "db",     state: "idle" },
];

// Maps OTel span action names to the edge that should animate
export const ACTION_TO_EDGE: Record<string, string> = {
  "handle_request":  "cdn-api",
  "db.query":        "api-db",
  "db.write":        "worker-db",
  "handle_async":    "cdn-api",
  "queue.enqueue":   "api-queue",
  "worker.process":  "queue-worker",
  "simulate_failure":"cdn-api",
};

// Maps OTel span action names to the node that should highlight
export const ACTION_TO_NODE: Record<string, string> = {
  "handle_request":  "api",
  "db.query":        "db",
  "db.write":        "db",
  "handle_async":    "api",
  "queue.enqueue":   "queue",
  "worker.process":  "worker",
  "simulate_failure":"api",
};
