package handler

import (
	"database/sql"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
)

var tracer = otel.Tracer("backend/handler")

type Handler struct {
	db *sql.DB

	// Simulated health state — toggled by /api/simulate-down
	mu           sync.RWMutex
	simulatedDown bool
	downUntil     time.Time
}

func New(db *sql.DB) *Handler {
	return &Handler{db: db}
}

// IsHealthy returns false when simulate-down is active.
func (h *Handler) IsHealthy() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.simulatedDown && time.Now().Before(h.downUntil) {
		return false
	}
	return true
}

// HandleRequest simulates a standard flow: API → DB
// This is the primary scenario visualized in the frontend.
func (h *Handler) HandleRequest(c *gin.Context) {
	ctx, span := tracer.Start(c.Request.Context(), "handle_request")
	defer span.End()

	cluster := os.Getenv("CLUSTER_ROLE")
	span.SetAttributes(attribute.String("cluster", cluster))

	// Simulate DB query with its own span
	dbCtx, dbSpan := tracer.Start(ctx, "db.query")
	time.Sleep(50 * time.Millisecond) // realistic DB latency
	_, err := h.db.ExecContext(dbCtx,
		"INSERT INTO requests (trace_id, status, cluster) VALUES ($1, $2, $3)",
		span.SpanContext().TraceID().String(), "success", cluster,
	)
	dbSpan.End()

	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"trace_id": span.SpanContext().TraceID().String(),
		"status":   "success",
		"cluster":  cluster,
	})
}

// HandleAsync simulates an async flow: API → (queue) → Worker → DB
func (h *Handler) HandleAsync(c *gin.Context) {
	ctx, span := tracer.Start(c.Request.Context(), "handle_async")
	defer span.End()

	cluster := os.Getenv("CLUSTER_ROLE")
	span.SetAttributes(
		attribute.String("cluster", cluster),
		attribute.String("flow", "async"),
	)

	// Simulate enqueue
	_, queueSpan := tracer.Start(ctx, "queue.enqueue")
	time.Sleep(20 * time.Millisecond)
	queueSpan.SetAttributes(attribute.String("queue", "requests"))
	queueSpan.End()

	// Simulate async worker processing
	_, workerSpan := tracer.Start(ctx, "worker.process")
	time.Sleep(80 * time.Millisecond)
	workerSpan.SetAttributes(attribute.String("worker", "request-processor"))
	workerSpan.End()

	// Simulate DB write from worker
	_, dbSpan := tracer.Start(ctx, "db.write")
	time.Sleep(40 * time.Millisecond)
	dbSpan.End()

	c.JSON(http.StatusAccepted, gin.H{
		"trace_id": span.SpanContext().TraceID().String(),
		"status":   "queued",
		"cluster":  cluster,
	})
}

// SimulateFailure simulates a failure scenario for UI demonstration.
// This triggers the failure visualization in the frontend.
func (h *Handler) SimulateFailure(c *gin.Context) {
	_, span := tracer.Start(c.Request.Context(), "simulate_failure")
	defer span.End()

	span.SetStatus(codes.Error, "simulated failure")
	span.SetAttributes(
		attribute.String("failure.type", "api_unavailable"),
		attribute.String("cluster", os.Getenv("CLUSTER_ROLE")),
	)

	c.JSON(http.StatusServiceUnavailable, gin.H{
		"error":   "simulated cluster failure",
		"cluster": os.Getenv("CLUSTER_ROLE"),
	})
}

// SimulateDown makes /healthz return 503 for the given duration (seconds).
// This triggers the Cloudflare Worker failover after FAILURE_THRESHOLD consecutive checks.
func (h *Handler) SimulateDown(c *gin.Context) {
	var req struct {
		DurationSec int `json:"duration_sec"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.DurationSec <= 0 {
		req.DurationSec = 300 // default 5 minutes
	}

	h.mu.Lock()
	h.simulatedDown = true
	h.downUntil = time.Now().Add(time.Duration(req.DurationSec) * time.Second)
	h.mu.Unlock()

	_, span := tracer.Start(c.Request.Context(), "simulate_down")
	span.SetAttributes(
		attribute.Int("duration_sec", req.DurationSec),
		attribute.String("cluster", os.Getenv("CLUSTER_ROLE")),
	)
	span.SetStatus(codes.Error, "cluster marked as down")
	span.End()

	c.JSON(http.StatusOK, gin.H{
		"status":       "down",
		"cluster":      os.Getenv("CLUSTER_ROLE"),
		"duration_sec": req.DurationSec,
		"recovers_at":  h.downUntil.UTC().Format(time.RFC3339),
	})
}

// SimulateRecover cancels a simulated outage immediately.
func (h *Handler) SimulateRecover(c *gin.Context) {
	h.mu.Lock()
	h.simulatedDown = false
	h.mu.Unlock()

	c.JSON(http.StatusOK, gin.H{
		"status":  "recovered",
		"cluster": os.Getenv("CLUSTER_ROLE"),
	})
}

// StreamEvents returns recent events via Server-Sent Events (SSE).
func (h *Handler) StreamEvents(c *gin.Context) {
	rows, err := h.db.QueryContext(c.Request.Context(),
		"SELECT trace_id, status, cluster, created_at FROM requests ORDER BY created_at DESC LIMIT 50",
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	var events []gin.H
	for rows.Next() {
		var traceID, status, cluster string
		var createdAt time.Time
		if err := rows.Scan(&traceID, &status, &cluster, &createdAt); err != nil {
			continue
		}
		events = append(events, gin.H{
			"trace_id":   traceID,
			"status":     status,
			"cluster":    cluster,
			"created_at": createdAt,
		})
	}

	c.JSON(http.StatusOK, events)
}

// ClusterInfo returns which cluster is currently serving the request.
// Used by the frontend to show the active cloud.
func (h *Handler) ClusterInfo(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"cluster": os.Getenv("CLUSTER_ROLE"),
		"cloud":   os.Getenv("CLOUD_PROVIDER"),
		"healthy": h.IsHealthy(),
	})
}
