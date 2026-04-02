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
		log.Fatalf("failed to bootstrap telemetry: %v", err)
	}
	defer shutdown(ctx)

	// Database connection
	database, err := db.Connect(os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatalf("failed to connect to database: %v", err)
	}
	defer database.Close()

	if err := db.Migrate(database); err != nil {
		log.Fatalf("failed to run migrations: %v", err)
	}

	// Router
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(otelgin.Middleware("backend")) // auto-instrument all routes

	// Health endpoints — checked by Cloudflare Worker every minute
	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })
	r.GET("/readyz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })
	r.GET("/livez", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })

	// App routes
	h := handler.New(database)
	api := r.Group("/api")
	{
		api.POST("/request", h.HandleRequest)   // triggers a traced flow: API → DB
		api.POST("/async", h.HandleAsync)        // triggers async flow: API → queue → worker
		api.POST("/fail", h.SimulateFailure)     // simulates failure for UI demonstration
		api.GET("/events", h.StreamEvents)       // SSE stream of recent events
		api.GET("/cluster", h.ClusterInfo)       // returns which cluster is serving (OCI/GCP)
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
