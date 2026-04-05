import * as d3 from "d3";
import { type Node, type Edge, NODES, EDGES } from "./nodes";

const NODE_ICONS: Record<string, string> = {
  user:       "\u{1F464}",
  cdn:        "\u{1F310}",
  "aks-api":  "\u{2699}",
  "gke-api":  "\u{2699}",
  db:         "\u{1F5C4}",
  queue:      "\u{1F4E8}",
  worker:     "\u{26A1}",
};

interface EdgeWithLatency extends Edge {
  latencyMs?: number;
}

export class GraphRenderer {
  private svg: d3.Selection<SVGSVGElement, unknown, HTMLElement, unknown>;
  private nodes: Node[];
  private edges: EdgeWithLatency[];
  private offsetX = 0;
  private offsetY = 0;

  constructor(svgSelector: string) {
    this.svg = d3.select<SVGSVGElement, unknown>(svgSelector);
    this.nodes = NODES.map((n) => ({ ...n }));
    this.edges = EDGES.map((e) => ({ ...e }));
    this.setupDefs();
    this.render();

    const ro = new ResizeObserver(() => this.render());
    const el = this.svg.node()?.parentElement;
    if (el) ro.observe(el);
  }

  private setupDefs(): void {
    const defs = this.svg.append("defs");

    const markers = [
      { id: "arrow-idle",   color: "#1e293b" },
      { id: "arrow-active", color: "#3b82f6" },
      { id: "arrow-error",  color: "#ef4444" },
    ];

    markers.forEach(({ id, color }) => {
      defs
        .append("marker")
        .attr("id", id)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 38)
        .attr("refY", 0)
        .attr("markerWidth", 6)
        .attr("markerHeight", 6)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-5L10,0L0,5")
        .attr("fill", color);
    });
  }

  private render(): void {
    const container = this.svg.node()?.parentElement;
    if (!container) return;

    const { width, height } = container.getBoundingClientRect();
    this.svg.attr("viewBox", `0 0 ${width} ${height}`);

    const graphWidth = 870;
    const graphHeight = 310;
    this.offsetX = (width - graphWidth) / 2;
    this.offsetY = (height - graphHeight) / 2;

    this.renderEdges();
    this.renderNodes();
    this.renderEdgeLabels();
  }

  private renderEdges(): void {
    this.svg
      .selectAll<SVGLineElement, EdgeWithLatency>(".link")
      .data(this.edges, (d) => d.id)
      .join("line")
      .attr("class", (d) => `link ${d.state !== "idle" ? d.state : ""}`)
      .attr("x1", (d) => this.offsetX + (this.nodeById(d.source)?.x ?? 0))
      .attr("y1", (d) => this.offsetY + (this.nodeById(d.source)?.y ?? 0))
      .attr("x2", (d) => this.offsetX + (this.nodeById(d.target)?.x ?? 0))
      .attr("y2", (d) => this.offsetY + (this.nodeById(d.target)?.y ?? 0))
      .attr("marker-end", (d) =>
        d.state === "active" ? "url(#arrow-active)"
        : d.state === "error" ? "url(#arrow-error)"
        : "url(#arrow-idle)"
      );
  }

  private renderEdgeLabels(): void {
    // Show latency label on active/error edges, hide on idle
    this.svg
      .selectAll<SVGTextElement, EdgeWithLatency>(".edge-latency")
      .data(this.edges, (d) => d.id)
      .join("text")
      .attr("class", (d) => `edge-latency ${d.state !== "idle" ? "visible" : ""}`)
      .attr("x", (d) => {
        const src = this.nodeById(d.source);
        const tgt = this.nodeById(d.target);
        if (!src || !tgt) return 0;
        return this.offsetX + (src.x + tgt.x) / 2;
      })
      .attr("y", (d) => {
        const src = this.nodeById(d.source);
        const tgt = this.nodeById(d.target);
        if (!src || !tgt) return 0;
        // Offset above the line
        const midY = this.offsetY + (src.y + tgt.y) / 2;
        return midY - 10;
      })
      .attr("text-anchor", "middle")
      .attr("fill", (d) => d.state === "error" ? "#ef4444" : "#3b82f6")
      .attr("font-size", "10px")
      .attr("font-family", "'JetBrains Mono', monospace")
      .attr("font-weight", "600")
      .attr("pointer-events", "none")
      .text((d) => {
        if (d.state === "idle") return "";
        if (d.latencyMs !== undefined && d.latencyMs > 0) {
          return d.latencyMs < 1 ? "<1ms" : `${d.latencyMs}ms`;
        }
        return d.state === "active" ? "..." : "ERR";
      });
  }

  private renderNodes(): void {
    const nodeGroups = this.svg
      .selectAll<SVGGElement, Node>(".node")
      .data(this.nodes, (d) => d.id)
      .join("g")
      .attr("class", (d) => `node state-${d.state}`)
      .attr("transform", (d) => `translate(${this.offsetX + d.x},${this.offsetY + d.y})`);

    // Outer glow ring
    nodeGroups
      .selectAll<SVGCircleElement, Node>(".ring")
      .data((d) => [d])
      .join("circle")
      .attr("class", "ring")
      .attr("r", 36)
      .attr("fill", "none")
      .attr("stroke", (d) =>
        d.state === "processing" ? "rgba(59,130,246,0.15)"
        : d.state === "success"  ? "rgba(34,197,94,0.15)"
        : d.state === "error"    ? "rgba(239,68,68,0.15)"
        : d.state === "down"     ? "rgba(239,68,68,0.08)"
        : "transparent"
      )
      .attr("stroke-width", 6);

    // Main circle
    nodeGroups
      .selectAll<SVGCircleElement, Node>("circle.main")
      .data((d) => [d])
      .join("circle")
      .attr("class", "main")
      .attr("r", 30);

    // Icon
    nodeGroups
      .selectAll<SVGTextElement, Node>(".node-icon")
      .data((d) => [d])
      .join("text")
      .attr("class", "node-icon")
      .attr("dy", "0.35em")
      .attr("text-anchor", "middle")
      .attr("font-size", "18px")
      .text((d) => d.state === "down" ? "\u{274C}" : (NODE_ICONS[d.id] ?? ""));

    // Label
    nodeGroups
      .selectAll<SVGTextElement, Node>("text.label")
      .data((d) => [d])
      .join("text")
      .attr("class", "label")
      .attr("dy", "0.35em")
      .attr("y", 48)
      .attr("text-anchor", "middle")
      .text((d) => d.label);
  }

  setNodeState(nodeId: string, state: Node["state"]): void {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    if (node.state === "down" && state !== "down" && state !== "idle") return;
    node.state = state;
    this.render();

    if (state !== "idle" && state !== "down") {
      setTimeout(() => {
        if (node.state !== "down") {
          node.state = "idle";
          this.render();
        }
      }, 1500);
    }
  }

  // Activate an edge with optional latency label
  setEdgeState(edgeId: string, state: Edge["state"], latencyMs?: number): void {
    const edge = this.edges.find((e) => e.id === edgeId);
    if (!edge) return;
    edge.state = state;
    if (latencyMs !== undefined) edge.latencyMs = latencyMs;
    this.render();

    if (state !== "idle") {
      setTimeout(() => {
        edge.state = "idle";
        edge.latencyMs = undefined;
        this.render();
      }, 1800);
    }
  }

  setClusterDown(clusterId: string, isDown: boolean): void {
    const node = this.nodes.find((n) => n.id === clusterId);
    if (!node) return;
    node.state = isDown ? "down" : "idle";
    this.render();
  }

  private nodeById(id: string): Node | undefined {
    return this.nodes.find((n) => n.id === id);
  }
}
