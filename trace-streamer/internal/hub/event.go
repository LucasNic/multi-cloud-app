package hub

// Event is the normalized, UI-friendly representation of an OTel span.
// This is exactly what the frontend receives via WebSocket.
//
// Design principle: the frontend must not know about OTel internals.
// The streamer normalizes all spans into this simple structure.
type Event struct {
	TraceID    string  `json:"trace_id"`
	SpanID     string  `json:"span_id"`
	Service    string  `json:"service"`
	Action     string  `json:"action"`
	Status     string  `json:"status"`  // "processing" | "success" | "error"
	DurationMS int64   `json:"duration_ms"`
	Timestamp  int64   `json:"timestamp"`
	Cluster    string  `json:"cluster,omitempty"`
	ParentID   string  `json:"parent_id,omitempty"`
}
