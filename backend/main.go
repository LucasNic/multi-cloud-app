package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/lucasnicoloso/multi-cloud-app/backend/internal/db"
	"github.com/lucasnicoloso/multi-cloud-app/backend/internal/handler"
	"github.com/lucasnicoloso/multi-cloud-app/backend/internal/telemetry"
	"go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin"
)

func main() {
	ctx := context.Background()

	// Bootstrap OpenTelemetry — all spans flow to OTel Collector
	shutdown, err := telemetry.Bootstrap(ctx)
	if err != nil {
		log.Printf("warning: telemetry bootstrap failed (spans will be dropped): %v", err)
	} else {
		defer shutdown(ctx)
	}

	// Database connection
	database, err := db.Connect(os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatalf("failed to connect to database: %v", err)
	}
	defer database.Close()

	if err := db.Migrate(database); err != nil {
		log.Fatalf("failed to run migrations: %v", err)
	}

	// Handler (owns simulated-down state)
	h := handler.New(database)

	// Router
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(otelgin.Middleware("backend")) // auto-instrument all routes

	// Health endpoints — checked by Cloudflare Worker every minute
	// /healthz respects simulated outage state for failover testing
	r.GET("/healthz", func(c *gin.Context) {
		if !h.IsHealthy() {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "down", "simulated": true})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
	r.GET("/readyz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })
	r.GET("/livez", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })

	// App routes
	api := r.Group("/api")
	{
		api.POST("/request", h.HandleRequest)      // triggers a traced flow: API → DB
		api.POST("/async", h.HandleAsync)           // triggers async flow: API → queue → worker
		api.POST("/fail", h.SimulateFailure)        // simulates failure for UI demonstration
		api.POST("/simulate-down", h.SimulateDown)  // makes /healthz return 503 (triggers CF failover)
		api.POST("/simulate-recover", h.SimulateRecover) // cancels simulated outage
		api.POST("/trigger-recovery", h.TriggerRecovery) // recovers AKS + switches DNS back via Worker
		api.GET("/events", h.StreamEvents)          // SSE stream of recent events
		api.GET("/cluster", h.ClusterInfo)          // returns which cluster is serving
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      r,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	log.Printf("backend starting on :%s (cluster: %s)", port, os.Getenv("CLUSTER_ROLE"))
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}
