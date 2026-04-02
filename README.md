# Multi-Cloud App

Application layer for the [multi-cloud-resilience-platform](https://github.com/LucasNic/multi-cloud-resilience-platform).

Three services:

| Service | Tech | Purpose |
|---|---|---|
| `backend` | Go + Gin + OpenTelemetry | API that handles requests and generates distributed traces |
| `trace-streamer` | Go + WebSocket + OTLP gRPC | Receives spans from OTel Collector, streams events to frontend |
| `frontend` | TypeScript + D3.js | Real-time visualization of distributed request flows |

## Local development

```bash
docker compose up
```

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:8080 |
| Jaeger UI | http://localhost:16686 |
| CockroachDB UI | http://localhost:8082 |

## How tracing works

```
User clicks button
  → Frontend calls Backend API (POST /api/request)
  → Backend generates OpenTelemetry spans
  → Spans exported to OTel Collector (gRPC :4317)
  → Collector forwards to Trace Streamer
  → Streamer normalizes spans → WebSocket events
  → Frontend receives events → D3 animates the graph
```

Every animation is driven by real telemetry. No mocks.

## CI/CD

On every push to `main`:
1. Tests run (Go + frontend build)
2. Docker images built and pushed to GHCR
3. Image tags updated in [multi-cloud-resilience-platform](https://github.com/LucasNic/multi-cloud-resilience-platform) K8s manifests
4. ArgoCD detects the manifest change and deploys to both OKE + GKE
