// WebSocket client — connects to trace-streamer and emits events.
// All frontend animations are driven exclusively by these real events.
// No mocks, no fake data.

export interface TraceEvent {
  trace_id: string;
  span_id: string;
  parent_id: string;
  service: string;
  action: string;
  status: "processing" | "success" | "error";
  duration_ms: number;
  timestamp: number;
  cluster: string;
}

type EventCallback = (event: TraceEvent) => void;

export class TraceStream {
  private ws: WebSocket | null = null;
  private callbacks: EventCallback[] = [];
  private reconnectDelay = 1000;

  constructor(private url: string) {}

  connect(): void {
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log("[stream] connected to trace-streamer");
      this.reconnectDelay = 1000;
    };

    this.ws.onmessage = (msg) => {
      try {
        const event: TraceEvent = JSON.parse(msg.data);
        this.callbacks.forEach((cb) => cb(event));
      } catch (e) {
        console.warn("[stream] failed to parse event", e);
      }
    };

    this.ws.onclose = () => {
      console.warn(`[stream] disconnected — reconnecting in ${this.reconnectDelay}ms`);
      setTimeout(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
        this.connect();
      }, this.reconnectDelay);
    };
  }

  onEvent(cb: EventCallback): void {
    this.callbacks.push(cb);
  }

  disconnect(): void {
    this.ws?.close();
  }
}
