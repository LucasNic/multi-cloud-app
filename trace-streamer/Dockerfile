FROM golang:1.22-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /trace-streamer ./main.go

FROM scratch
COPY --from=builder /trace-streamer /trace-streamer
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

EXPOSE 8081 4317
ENTRYPOINT ["/trace-streamer"]
