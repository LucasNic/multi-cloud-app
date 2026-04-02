package collector

import (
	"context"
	"fmt"
	"log"
	"net"
	"time"

	"github.com/lucasnicoloso/multi-cloud-app/trace-streamer/internal/hub"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/grpc"
)

// Receiver implements the OTLP trace collector gRPC service.
// It receives spans from the OTel Collector and normalizes them into
// hub.Event structs for WebSocket delivery to the frontend.
type Receiver struct {
	collectortrace.UnimplementedTraceServiceServer
	hub *hub.Hub
}

func NewReceiver(h *hub.Hub) *Receiver {
	return &Receiver{hub: h}
}

func (r *Receiver) Start(addr string) error {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	srv := grpc.NewServer()
	collectortrace.RegisterTraceServiceServer(srv, r)
	log.Printf("OTLP receiver listening on %s", addr)
	return srv.Serve(lis)
}

// Export receives spans from the OTel Collector and converts them to Events.
func (r *Receiver) Export(ctx context.Context, req *collectortrace.ExportTraceServiceRequest) (*collectortrace.ExportTraceServiceResponse, error) {
	for _, rs := range req.ResourceSpans {
		for _, ss := range rs.ScopeSpans {
			for _, span := range ss.Spans {
				event := spanToEvent(span)
				select {
				case r.hub.Events <- event:
				default:
					// buffer full — skip
				}
			}
		}
	}
	return &collectortrace.ExportTraceServiceResponse{}, nil
}

func spanToEvent(span *tracepb.Span) hub.Event {
	status := "success"
	if span.Status != nil && span.Status.Code == tracepb.Status_STATUS_CODE_ERROR {
		status = "error"
	}

	startNano := int64(span.StartTimeUnixNano)
	endNano := int64(span.EndTimeUnixNano)
	durationMS := (endNano - startNano) / int64(time.Millisecond)

	traceID := formatID(span.TraceId)
	spanID := formatID(span.SpanId)
	parentID := formatID(span.ParentSpanId)

	cluster := attrString(span.Attributes, "cluster")

	return hub.Event{
		TraceID:    traceID,
		SpanID:     spanID,
		ParentID:   parentID,
		Service:    attrString(span.Attributes, "service.name"),
		Action:     span.Name,
		Status:     status,
		DurationMS: durationMS,
		Timestamp:  startNano / int64(time.Millisecond),
		Cluster:    cluster,
	}
}

func attrString(attrs []*commonpb.KeyValue, key string) string {
	for _, a := range attrs {
		if a.Key == key {
			if sv, ok := a.Value.Value.(*commonpb.AnyValue_StringValue); ok {
				return sv.StringValue
			}
		}
	}
	return ""
}

func formatID(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	return fmt.Sprintf("%x", b)
}
