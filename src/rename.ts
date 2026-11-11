// Node renaming from the panel options: "10.10.10.10 = prod-postgres", one mapping per line.
import type { Graph, GraphEdge, GraphNode, Hop } from './types';

export type Renames = ReadonlyMap<string, string>;

/**
 * Parse the rename option. One `from = to` per line (`=>`, `->` and `:` work too, as long as the
 * separator has spaces around it or is `=`); blank lines and lines starting with # are ignored.
 */
export function parseRenames(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(.+?)\s*(?:=>|->|=|\s:\s)\s*(.+)$/);
    if (!m) continue;
    const from = unquote(m[1]), to = unquote(m[2]);
    // `user` is the service graph's name for callers without a parent span: keep it special
    if (from && to && from !== to && from !== 'user') out.set(from, to);
  }
  return out;
}

function unquote(s: string): string {
  return s.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
}

const name = (r: Renames, s: string) => r.get(s) ?? s;

/** A hop with its node names (caller, callee and the callee's group path) renamed. */
export function renameHop(h: Hop, r: Renames): Hop {
  if (!r.size) return h;
  const f = name(r, h.f), to = name(r, h.to);
  const tg = h.tg?.map((g) => name(r, g));
  if (f === h.f && to === h.to && (!tg || tg.every((g, i) => g === h.tg?.[i]))) return h;
  return { ...h, f, to, tg };
}

/** The service graph with nodes renamed; nodes and edges that end up with the same name merge. */
export function renameGraph(g: Graph, r: Renames): Graph {
  if (!r.size) return g;
  const nodes = new Map<string, GraphNode & { lat: number }>();
  for (const n of g.nodes) {
    const id = name(r, n.id);
    const m = nodes.get(id);
    if (!m) {
      nodes.set(id, { ...n, id, lat: (n.mean ?? 0) * n.rate });
      continue;
    }
    m.rate += n.rate;
    m.errRate += n.errRate;
    m.outRate += n.outRate;
    m.lat += (n.mean ?? 0) * n.rate;
    if (m.kind === 'service') m.kind = n.kind;
  }
  for (const n of nodes.values()) n.mean = n.rate > 0 && n.lat > 0 ? n.lat / n.rate : n.mean;

  const edges = new Map<string, GraphEdge & { lat: number }>();
  for (const e of g.edges) {
    const source = name(r, e.source), target = name(r, e.target);
    if (source === target && source !== e.source) continue;   // merged into one node: no self loop
    const k = `${source}\u001f${target}`;
    const m = edges.get(k);
    if (!m) {
      edges.set(k, { ...e, source, target, lat: (e.mean ?? 0) * e.rate });
      continue;
    }
    m.rate += e.rate;
    m.errRate += e.errRate;
    m.lat += (e.mean ?? 0) * e.rate;
    m.mean = m.rate > 0 && m.lat > 0 ? m.lat / m.rate : m.mean;
  }
  return {
    nodes: [...nodes.values()].map(({ lat: _l, ...n }) => n),
    edges: [...edges.values()].map(({ lat: _l, ...e }) => e),
  };
}
