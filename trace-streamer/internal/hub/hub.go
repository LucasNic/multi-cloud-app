package hub

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// client represents a connected WebSocket frontend client.
type client struct {
	conn    *websocket.Conn
	send    chan []byte
	traceID string // if set, only receives events for this trace
}

// Hub manages all active WebSocket connections.
// When an event arrives (from the OTel receiver), it broadcasts
// to all clients subscribed to that trace_id (or all, if unfiltered).
type Hub struct {
	mu      sync.RWMutex
	clients map[*client]struct{}
	Events  chan Event
}

func New() *Hub {
	return &Hub{
		clients: make(map[*client]struct{}),
		Events:  make(chan Event, 256),
	}
}

// Run is the main event loop. Must be called in a goroutine.
func (h *Hub) Run() {
	for event := range h.Events {
		data, err := json.Marshal(event)
		if err != nil {
			continue
		}
		h.broadcast(event.TraceID, data)
	}
}

func (h *Hub) broadcast(traceID string, data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for c := range h.clients {
		if c.traceID != "" && c.traceID != traceID {
			continue // client is filtering by trace_id
		}
		select {
		case c.send <- data:
		default:
			// client is slow — drop the event rather than block
		}
	}
}

// ServeWS upgrades an HTTP connection to WebSocket.
// Query param: ?trace_id=abc to subscribe to a specific trace.
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("websocket upgrade error: %v", err)
		return
	}

	c := &client{
		conn:    conn,
		send:    make(chan []byte, 64),
		traceID: r.URL.Query().Get("trace_id"),
	}

	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()

	log.Printf("client connected (trace_id=%q, total=%d)", c.traceID, len(h.clients))

	go c.writePump()
	c.readPump(func() {
		h.mu.Lock()
		delete(h.clients, c)
		h.mu.Unlock()
		conn.Close()
		log.Printf("client disconnected (total=%d)", len(h.clients))
	})
}

func (c *client) writePump() {
	for data := range c.send {
		if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
			return
		}
	}
}

func (c *client) readPump(onClose func()) {
	defer onClose()
	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			return
		}
	}
}
