import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { fetchMemoryGraph } from "../api";

/**
 * MemoryGraph — a force-directed layout of the user's memories.
 *
 * Positions come from a small spring/repulsion simulation rather than a fixed
 * grid, so nodes spread out and related memories settle near each other. The
 * view auto-fits the node bounds and nodes can be dragged to rearrange.
 */

const NODE_R = 9;
const REFRESH_MS = 20000;

const EMPTY = { nodes: [], edges: [], memory_count: 0, connection_count: 0 };

/** ── layout ─────────────────────────────────────────────────────────────── */

function simulate(nodes, edges, ticks = null) {
  const n = nodes.length;
  if (n === 0) return nodes;

  // Repulsion is O(n^2) per tick, so keep the total work bounded as the graph
  // grows instead of freezing the tab on a large memory bank.
  const steps = ticks || Math.max(120, Math.min(320, Math.round(90000 / n)));

  // Seed along a golden-angle spiral so even 2-3 nodes start spread in 2D
  // rather than stacked on a line (a plain circle puts 2 nodes at either end
  // of one axis, and the springs then keep them collinear).
  let angle = 0;
  nodes.forEach((node, i) => {
    if (typeof node.x !== "number") {
      const r = 26 * Math.sqrt(i + 0.6);
      angle += 2.399963229728653; // golden angle in radians
      node.x = Math.cos(angle) * r;
      node.y = Math.sin(angle) * r;
    }
    node.vx = 0;
    node.vy = 0;
  });

  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const pairs = edges
    .map((e) => [index.get(e.source), index.get(e.target)])
    .filter(([a, b]) => a !== undefined && b !== undefined && a !== b);

  for (let step = 0; step < steps; step++) {
    const alpha = 1 - step / steps;

    // pairwise repulsion
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = (Math.random() - 0.5) * 2;
          dy = (Math.random() - 0.5) * 2;
          d2 = 1;
        }
        const d = Math.sqrt(d2);
        const force = 5200 / d2;
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    // springs along edges
    for (const [i, j] of pairs) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const force = (d - 92) * 0.055;
      const fx = (dx / d) * force;
      const fy = (dy / d) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // integrate, with a gentle pull toward the centre
    for (const node of nodes) {
      if (node.fixed) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx -= node.x * 0.012;
      node.vy -= node.y * 0.012;
      node.vx *= 0.82;
      node.vy *= 0.82;
      node.x += node.vx * alpha * 1.6;
      node.y += node.vy * alpha * 1.6;
    }
  }
  return nodes;
}

/** ── component ──────────────────────────────────────────────────────────── */

export default function MemoryGraphPage() {
  const { token } = useAuth();
  const [graph, setGraph] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(null);
  const [, bump] = useState(0);
  const dragRef = useRef(null);
  const nodesRef = useRef([]);

  const load = useCallback(
    async (silent = false) => {
      if (!token) return;
      if (!silent) setLoading(true);
      try {
        const data = await fetchMemoryGraph(token);
        setGraph(data && data.nodes ? data : EMPTY);
        setUpdatedAt(new Date());
      } catch {
        if (!silent) setGraph(EMPTY);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [token]
  );

  useEffect(() => {
    load();
  }, [load]);

  // mem0 extracts asynchronously, so re-poll instead of making the user reload.
  useEffect(() => {
    const id = setInterval(() => load(true), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  // Re-run the layout whenever the node/edge set changes.
  const layoutKey = useMemo(
    () =>
      `${graph.nodes.map((n) => n.id).join("|")}#${graph.edges
        .map((e) => e.id)
        .join("|")}`,
    [graph]
  );

  useEffect(() => {
    if (!graph.nodes.length) {
      nodesRef.current = [];
      return;
    }
    nodesRef.current = simulate(
      graph.nodes.map((n) => ({ ...n })),
      graph.edges.map((e) => ({ ...e }))
    );
    bump((v) => v + 1);
  }, [layoutKey, graph]);

  const nodes = nodesRef.current;
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const visible = useMemo(
    () => (filter === "all" ? nodes : nodes.filter((n) => n.kind === filter)),
    [nodes, filter]
  );
  const visibleIds = useMemo(() => new Set(visible.map((n) => n.id)), [visible]);

  // Fit the layout into the SVG's fixed coordinate space.
  const view = useMemo(() => {
    const W = 1000;
    const H = 720;
    if (!visible.length) return { W, H, k: 1, tx: W / 2, ty: H / 2 };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of visible) {
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y);
    }
    const spanX = Math.max(40, maxX - minX);
    const spanY = Math.max(40, maxY - minY);
    const k = Math.min((W - 150) / spanX, (H - 150) / spanY);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return { W, H, k, tx: W / 2 - cx * k, ty: H / 2 - cy * k };
  }, [visible]);

  const kinds = useMemo(() => {
    const counts = { fact: 0, lesson: 0 };
    for (const n of nodes) counts[n.kind] = (counts[n.kind] || 0) + 1;
    return counts;
  }, [nodes]);

  /** ── dragging ─────────────────────────────────────────────────────────── */
  const onPointerDown = (e, node) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const svg = e.currentTarget.ownerSVGElement;
    dragRef.current = { id: node.id, rect: svg.getBoundingClientRect() };
  };

  const onPointerMove = (e) => {
    const drag = dragRef.current;
    if (!drag) return;
    const node = byId.get(drag.id);
    if (!node) return;
    const { rect } = drag;
    // screen -> svg -> layout coordinates
    const svgX = ((e.clientX - rect.left) / rect.width) * view.W;
    const svgY = ((e.clientY - rect.top) / rect.height) * view.H;
    node.x = (svgX - view.tx) / view.k;
    node.y = (svgY - view.ty) / view.k;
    node.fixed = true;
    bump((v) => v + 1);
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const node = byId.get(drag.id);
    if (node) {
      node.fixed = false;
      // settle the rest of the graph around the new position
      simulate(nodes, graph.edges.map((e) => ({ ...e })), 80);
    }
    bump((v) => v + 1);
  };

  const empty = !loading && graph.memory_count === 0;
  const selectedText =
    selected && graph.nodes.find((n) => n.id === selected)?.text;

  return (
    <div className="k-app k-surface">
      <aside className="k-side">
        <div className="k-side-top">
          <Link to="/" className="k-side-back" title="Back to chat">
            ←
          </Link>
          <span className="k-side-brand">Memory graph</span>
        </div>

        <div className="k-side-group">
          <div className="k-group-label">
            <span>Graph</span>
            <button
              type="button"
              className="k-side-refresh"
              onClick={() => load()}
              disabled={loading}
              title="Refresh"
              aria-label="Refresh graph"
            >
              ⟳
            </button>
          </div>

          <div className="k-project">
            <span className="k-project-name">{graph.memory_count} memories</span>
            <span className="k-project-meta">{graph.connection_count} links</span>
          </div>

          <div className="k-chips k-graph-filter">
            {[
              ["all", `All ${nodes.length}`],
              ["fact", `Facts ${kinds.fact || 0}`],
              ["lesson", `Lessons ${kinds.lesson || 0}`],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`k-chip k-chip--btn${filter === key ? " is-on" : ""}`}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="k-side-group k-side-files">
          <div className="k-group-label">
            <span>Memories</span>
            <span className="k-group-count">{visible.length}</span>
          </div>

          {loading && <p className="k-side-note">Loading…</p>}
          {empty && (
            <p className="k-side-note">
              Nothing remembered yet. Chat with Zen and facts will appear here.
            </p>
          )}

          <ul className="k-file-list">
            {visible.map((node) => (
              <li key={node.id}>
                <button
                  type="button"
                  className={`k-file${selected === node.id ? " is-active" : ""}`}
                  onClick={() => setSelected(node.id === selected ? null : node.id)}
                  title={node.text}
                >
                  <span className={`k-dot k-dot--${node.kind}`} />
                  <span className="k-file-name">{node.text}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="k-side-foot">
          <span className="k-side-note">
            {updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : "—"}
          </span>
        </div>
      </aside>

      <div className="k-content">
        <section className="k-graph-pane">
          {loading && <p className="k-graph-hint">Loading graph…</p>}

          {empty && (
            <div className="k-graph-empty">
              <h2>No memories yet</h2>
              <p>Start chatting with Zen and your memory graph will build itself.</p>
              <Link to="/" className="k-btn">
                Open chat
              </Link>
            </div>
          )}

          {!loading && !empty && (
            <svg
              className="k-graph-svg"
              viewBox={`0 0 ${view.W} ${view.H}`}
              preserveAspectRatio="xMidYMid meet"
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
            >
              <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
                {graph.edges.map((edge) => {
                  const a = byId.get(edge.source);
                  const b = byId.get(edge.target);
                  if (!a || !b) return null;
                  if (!visibleIds.has(a.id) || !visibleIds.has(b.id)) return null;
                  const dim = selected && selected !== a.id && selected !== b.id;
                  return (
                    <line
                      key={edge.id}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      className={`k-edge${
                        edge.label === "similar" ? " k-edge--sim" : ""
                      }${dim ? " is-dim" : ""}`}
                    />
                  );
                })}

                {visible.map((node) => {
                  const dim = selected && selected !== node.id;
                  return (
                    <g
                      key={node.id}
                      className={`k-node k-node--${node.kind}${
                        dim ? " is-dim" : ""
                      }${selected === node.id ? " is-selected" : ""}`}
                      onPointerDown={(e) => onPointerDown(e, node)}
                    >
                      <circle cx={node.x} cy={node.y} r={NODE_R} />
                      <text x={node.x} y={node.y + 3.4}>
                        {node.kind === "lesson" ? "L" : "F"}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
          )}

          {!empty && !loading && (
            <div className="k-graph-tip">
              {selectedText || "Drag a node to rearrange · click one to focus it"}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
