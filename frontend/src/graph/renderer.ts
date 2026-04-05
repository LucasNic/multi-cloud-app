import * as d3 from "d3";
import { type Node, type Edge, NODES, EDGES } from "./nodes";

// GraphRenderer manages the D3 SVG visualization.
// It never generates data — it only reflects the state passed to it.
// All state changes come from real WebSocket events (via main.ts).

const NODE_ICONS: Record<string, string> = {
  user: "\u{1F464}",      // 👤
  cdn: "\u{1F310}",       // 🌐
  api: "\u{2699}",        // ⚙
  db: "\u{1F5C4}",        // 🗄
  queue: "\u{1F4E8}",     // 📨
  worker: "\u{26A1}",     // ⚡
};

export class GraphRenderer {
  private svg: d3.Selection<SVGSVGElement, unknown, HTMLElement, unknown>;
  private nodes: Node[];
  private edges: Edge[];

  constructor(svgSelector: string) {
    this.svg = d3.select<SVGSVGElement, unknown>(svgSelector);
    this.nodes = NODES.map((n) => ({ ...n }));
    this.edges = EDGES.map((e) => ({ ...e }));
    this.setupDefs();
    this.render();

    // Re-render on resize to keep centered
    const ro = new ResizeObserver(() => this.render());
    const el = this.svg.node()?.parentElement;
    if (el) ro.observe(el);
  }

  private setupDefs(): void {
    const defs = this.svg.append("defs");

    // Arrow markers
    const markers = [
      { id: "arrow-idle", color: "#1e293b" },
      { id: "arrow-active", color: "#3b82f6" },
      { id: "arrow-error", color: "#ef4444" },
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

    // Glow filter for active nodes
    const glow = defs.append("filter").attr("id", "glow");
    glow
      .append("feGaussianBlur")
      .attr("stdDeviation", "4")
      .attr("result", "coloredBlur");
    const merge = glow.append("feMerge");
    merge.append("feMergeNode").attr("in", "coloredBlur");
    merge.append("feMergeNode").attr("in", "SourceGraphic");
  }

  private render(): void {
    const container = this.svg.node()?.parentElement;
    if (!container) return;

    const { width, height } = container.getBoundingClientRect();
    this.svg.attr("viewBox", `0 0 ${width} ${height}`);

    // Center the graph
    const graphWidth = 760;
    const graphHeight = 280;
    const offsetX = (width - graphWidth) / 2;
    const offsetY = (height - graphHeight) / 2;

    // Edges
    this.svg
      .selectAll<SVGLineElement, Edge>(".link")
      .data(this.edges, (d) => d.id)
      .join("line")
      .attr("class", (d) => `link ${d.state !== "idle" ? d.state : ""}`)
      .attr("x1", (d) => offsetX + (this.nodeById(d.source)?.x ?? 0))
      .attr("y1", (d) => offsetY + (this.nodeById(d.source)?.y ?? 0))
      .attr("x2", (d) => offsetX + (this.nodeById(d.target)?.x ?? 0))
      .attr("y2", (d) => offsetY + (this.nodeById(d.target)?.y ?? 0))
      .attr("marker-end", (d) =>
        d.state === "active"
          ? "url(#arrow-active)"
          : d.state === "error"
          ? "url(#arrow-error)"
          : "url(#arrow-idle)"
      );

    // Nodes
    const nodeGroups = this.svg
      .selectAll<SVGGElement, Node>(".node")
      .data(this.nodes, (d) => d.id)
      .join("g")
      .attr("class", (d) => `node state-${d.state}`)
      .attr("transform", (d) => `translate(${offsetX + d.x},${offsetY + d.y})`);

    // Outer glow ring (only for active states)
    nodeGroups
      .selectAll<SVGCircleElement, Node>(".ring")
      .data((d) => [d])
      .join("circle")
      .attr("class", "ring")
      .attr("r", 36)
      .attr("fill", "none")
      .attr("stroke", (d) =>
        d.state === "processing" ? "rgba(59,130,246,0.15)"
        : d.state === "success" ? "rgba(34,197,94,0.15)"
        : d.state === "error" ? "rgba(239,68,68,0.15)"
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
      .text((d) => NODE_ICONS[d.id] ?? "");

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
    node.state = state;
    this.render();

    if (state !== "idle") {
      setTimeout(() => {
        node.state = "idle";
        this.render();
      }, 1500);
    }
  }

  setEdgeState(edgeId: string, state: Edge["state"]): void {
    const edge = this.edges.find((e) => e.id === edgeId);
    if (!edge) return;
    edge.state = state;
    this.render();

    if (state !== "idle") {
      setTimeout(() => {
        edge.state = "idle";
        this.render();
      }, 1200);
    }
  }

  setCluster(cluster: string): void {
    const apiNode = this.nodes.find((n) => n.id === "api");
    if (!apiNode) return;
    apiNode.label =
      cluster === "primary" ? "API (AKS)"
      : cluster === "secondary" ? "API (GKE)"
      : "API";
    this.render();
  }

  private nodeById(id: string): Node | undefined {
    return this.nodes.find((n) => n.id === id);
  }
}
