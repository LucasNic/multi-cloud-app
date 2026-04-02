import * as d3 from "d3";
import { Node, Edge, NODES, EDGES } from "./nodes";

// GraphRenderer manages the D3 SVG visualization.
// It never generates data — it only reflects the state passed to it.
// All state changes come from real WebSocket events (via main.ts).

export class GraphRenderer {
  private svg: d3.Selection<SVGSVGElement, unknown, HTMLElement, unknown>;
  private nodes: Node[];
  private edges: Edge[];

  constructor(svgSelector: string) {
    this.svg = d3.select<SVGSVGElement, unknown>(svgSelector);
    this.nodes = NODES.map((n) => ({ ...n }));
    this.edges = EDGES.map((e) => ({ ...e }));
    this.render();
  }

  private render(): void {
    const { width, height } = (this.svg.node() as SVGSVGElement).getBoundingClientRect();

    // Edges
    this.svg
      .selectAll<SVGLineElement, Edge>(".link")
      .data(this.edges, (d) => d.id)
      .join("line")
      .attr("class", (d) => `link ${d.state !== "idle" ? d.state : ""}`)
      .attr("x1", (d) => this.nodeById(d.source)?.x ?? 0)
      .attr("y1", (d) => this.nodeById(d.source)?.y ?? 0)
      .attr("x2", (d) => this.nodeById(d.target)?.x ?? 0)
      .attr("y2", (d) => this.nodeById(d.target)?.y ?? 0);

    // Nodes
    const nodeGroups = this.svg
      .selectAll<SVGGElement, Node>(".node")
      .data(this.nodes, (d) => d.id)
      .join("g")
      .attr("class", (d) => `node state-${d.state}`)
      .attr("transform", (d) => `translate(${d.x},${d.y})`);

    nodeGroups
      .selectAll("circle")
      .data((d) => [d])
      .join("circle")
      .attr("r", 28);

    nodeGroups
      .selectAll("text")
      .data((d) => [d])
      .join("text")
      .attr("dy", "0.35em")
      .attr("y", 42)
      .text((d) => d.label);
  }

  // Update a node's visual state
  setNodeState(nodeId: string, state: Node["state"]): void {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    node.state = state;
    this.render();

    // Auto-reset to idle after animation completes
    if (state !== "idle") {
      setTimeout(() => {
        node.state = "idle";
        this.render();
      }, 1500);
    }
  }

  // Activate an edge (animate the flow arrow)
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

  // Update the API node label to reflect which cluster is active
  setCluster(cluster: string): void {
    const apiNode = this.nodes.find((n) => n.id === "api");
    if (!apiNode) return;
    const label = cluster === "oci" ? "API (OKE)" : cluster === "gcp" ? "API (GKE)" : "API";
    apiNode.label = label;
    this.render();
  }

  private nodeById(id: string): Node | undefined {
    return this.nodes.find((n) => n.id === id);
  }
}
