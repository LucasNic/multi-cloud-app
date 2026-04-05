package handler

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
)

var tracer = otel.Tracer("backend/handler")

type Handler struct {
	db *sql.DB
}

func New(db *sql.DB) *Handler {
	return &Handler{db: db}
}

// isDown checks if this cluster is in simulated-down state (DB-backed, shared across all pods).
func (h *Handler) isDown() bool {
	cluster := os.Getenv("CLUSTER_ROLE")
	if cluster == "" {
		return false
	}
	var isDown bool
	var downUntil sql.NullTime
	err := h.db.QueryRow(
		"SELECT is_down, down_until FROM cluster_state WHERE cluster = $1", cluster,
	).Scan(&isDown, &downUntil)
	if err != nil {
		return false // no row = not down
	}
	if !isDown {
		return false
	}
	// Auto-recover if down_until has passed
	if downUntil.Valid && time.Now().After(downUntil.Time) {
		h.db.Exec("UPDATE cluster_state SET is_down = false WHERE cluster = $1", cluster)
		return false
	}
	return true
}

// IsHealthy is called by the /healthz endpoint in main.go.
func (h *Handler) IsHealthy() bool {
	return !h.isDown()
}

// HandleRequest simulates a standard flow: API → DB
func (h *Handler) HandleRequest(c *gin.Context) {
	ctx, span := tracer.Start(c.Request.Context(), "handle_request")
	defer span.End()

	cluster := os.Getenv("CLUSTER_ROLE")
	span.SetAttributes(attribute.String("cluster", cluster))

	// Check if cluster is simulated-down
	if h.isDown() {
		span.SetStatus(codes.Error, "cluster is down (simulated)")
		span.SetAttributes(attribute.Bool("simulated_outage", true))
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error":   "cluster is down (simulated outage)",
			"cluster": cluster,
		})
		return
	}

	// DB query span
	dbCtx, dbSpan := tracer.Start(ctx, "db.query")
	time.Sleep(50 * time.Millisecond)
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

	if h.isDown() {
		span.SetStatus(codes.Error, "cluster is down (simulated)")
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error":   "cluster is down (simulated outage)",
			"cluster": cluster,
		})
		return
	}

	_, queueSpan := tracer.Start(ctx, "queue.enqueue")
	time.Sleep(20 * time.Millisecond)
	queueSpan.SetAttributes(attribute.String("queue", "requests"))
	queueSpan.End()

	_, workerSpan := tracer.Start(ctx, "worker.process")
	time.Sleep(80 * time.Millisecond)
	workerSpan.SetAttributes(attribute.String("worker", "request-processor"))
	workerSpan.End()

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

// SimulateDown marks this cluster as "down" in the database.
// All pods sharing the DB will see it and start returning 503.
func (h *Handler) SimulateDown(c *gin.Context) {
	var req struct {
		DurationSec int `json:"duration_sec"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.DurationSec <= 0 {
		req.DurationSec = 300
	}

	cluster := os.Getenv("CLUSTER_ROLE")
	downUntil := time.Now().Add(time.Duration(req.DurationSec) * time.Second)

	_, err := h.db.Exec(`
		UPSERT INTO cluster_state (cluster, is_down, down_until, updated_at)
		VALUES ($1, true, $2, now())
	`, cluster, downUntil)

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	_, span := tracer.Start(c.Request.Context(), "simulate_down")
	span.SetAttributes(
		attribute.Int("duration_sec", req.DurationSec),
		attribute.String("cluster", cluster),
	)
	span.SetStatus(codes.Error, "cluster marked as down")
	span.End()

	// Trigger the Cloudflare Worker immediately so DNS failover happens
	// in seconds rather than waiting up to 4 minutes for the cron.
	go triggerWorkerFailover()

	c.JSON(http.StatusOK, gin.H{
		"status":       "down",
		"cluster":      cluster,
		"duration_sec": req.DurationSec,
		"recovers_at":  downUntil.UTC().Format(time.RFC3339),
	})
}

// triggerWorkerFailover calls the Cloudflare Worker's HTTP /trigger endpoint
// so DNS is updated immediately rather than waiting for the next cron run.
func triggerWorkerFailover() {
	workerURL := os.Getenv("WORKER_URL")
	workerSecret := os.Getenv("WORKER_SECRET")
	if workerURL == "" || workerSecret == "" {
		log.Printf("[failover] WORKER_URL or WORKER_SECRET not set — skipping instant trigger")
		return
	}

	body, _ := json.Marshal(map[string]bool{"force_check": true})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", workerURL+"/trigger", bytes.NewReader(body))
	if err != nil {
		log.Printf("[failover] failed to create worker request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+workerSecret)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("[failover] worker trigger failed: %v", err)
		return
	}
	defer resp.Body.Close()
	log.Printf("[failover] worker trigger response: %d", resp.StatusCode)
}

// SimulateRecover marks this cluster as healthy in the database.
func (h *Handler) SimulateRecover(c *gin.Context) {
	cluster := os.Getenv("CLUSTER_ROLE")
	h.db.Exec(`
		UPSERT INTO cluster_state (cluster, is_down, down_until, updated_at)
		VALUES ($1, false, NULL, now())
	`, cluster)

	c.JSON(http.StatusOK, gin.H{
		"status":  "recovered",
		"cluster": cluster,
	})
}

// StreamEvents returns recent request events from the database.
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
func (h *Handler) ClusterInfo(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"cluster": os.Getenv("CLUSTER_ROLE"),
		"cloud":   os.Getenv("CLOUD_PROVIDER"),
		"healthy": !h.isDown(),
	})
}
