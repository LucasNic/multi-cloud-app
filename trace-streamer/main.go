package main

import (
	"log"
	"net/http"
	"os"

	"github.com/lucasnicoloso/multi-cloud-app/trace-streamer/internal/collector"
	"github.com/lucasnicoloso/multi-cloud-app/trace-streamer/internal/hub"
)

// trace-streamer bridges OpenTelemetry spans → WebSocket events.
//
// Flow:
//   OTel Collector (OTLP gRPC) → trace-streamer → WebSocket → Frontend
//
// The streamer receives spans via OTLP, normalizes them into UI-friendly
// events (see internal/hub/event.go), and broadcasts to all connected
// WebSocket clients filtered by trace_id.

func main() {
	// Hub manages all WebSocket connections and broadcasts events
	h := hub.New()
	go h.Run()

	// OTLP receiver: listens for spans from OTel Collector
	recv := collector.NewReceiver(h)
	go func() {
		if err := recv.Start(":4317"); err != nil {
			log.Fatalf("OTLP receiver error: %v", err)
		}
	}()

	// WebSocket endpoint for the frontend
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", h.ServeWS)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8081"
	}

	log.Printf("trace-streamer listening on :%s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatalf("http server error: %v", err)
	}
}
