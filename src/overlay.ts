// 2D canvas on top of the WebGPU canvas: node labels, Tempo-style stats, floating text.
import { css, type Scene, type SceneNode } from './scene';
import type { Camera, Rgb } from './types';

export const fmtRate = (r: number) => (r >= 100 ? r.toFixed(0) : r >= 10 ? r.toFixed(1) : r.toFixed(2));
export const fmtMs = (ms: number | null) =>
  ms == null ? '–' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : ms >= 100 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(1)} ms`;

const MONO = '"JetBrains Mono", ui-monospace, monospace';
const SANS = 'Inter, system-ui, sans-serif';

export class Overlay {
  labels = true;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get a 2D canvas context.');
    this.ctx = ctx;
  }

  resize(w: number, h: number, dpr: number): void {
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.dpr = dpr;
    this.w = w;
    this.h = h;
  }

  /** basic: no WebGPU, so draw the graph itself here too (plain 2D: no glow, no particles) */
  draw(scene: Scene, cam: Camera, basic = false): void {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    const z = cam.zoom;
    const sx = (x: number) => (x - cam.x) * z + this.w / 2;
    const sy = (y: number) => (y - cam.y) * z + this.h / 2;
    if (basic) this.drawBasic(scene, sx, sy, z);
    const fs = scene.focusSet();
    c.textAlign = 'center';
    c.textBaseline = 'middle';

    // edge label under the cursor
    const e = scene.hoverEdge ? scene.edges.get(scene.hoverEdge) : undefined;
    if (e) {
      const p = e.at(0.5, [0, 0, 0, 0]);
      const txt = `${fmtRate(e.rate)} r/s · ${fmtMs(e.mean)}${e.err > 0 ? ` · ${((e.err / Math.max(e.rate, 1e-9)) * 100).toFixed(1)}% err` : ''}`;
      c.font = `600 11px ${SANS}`;
      const w = c.measureText(txt).width + 14;
      c.fillStyle = 'rgba(14,16,24,0.88)';
      c.strokeStyle = 'rgba(255,255,255,0.12)';
      roundRect(c, sx(p[0]) - w / 2, sy(p[1]) - 11, w, 22, 6);
      c.fill();
      c.stroke();
      c.fillStyle = '#d8e0ee';
      c.fillText(txt, sx(p[0]), sy(p[1]) + 0.5);
    }

    if (this.labels) {
      // Labels are drawn in priority order; one that would overlap a label already drawn is
      // skipped (it shows when zoomed in). Group labels first, outer groups before inner ones.
      const placed: [number, number, number, number][] = [];
      const free = (x0: number, y0: number, x1: number, y1: number) =>
        !placed.some((p) => x0 < p[2] && x1 > p[0] && y0 < p[3] && y1 > p[1]);
      for (const g of [...scene.groups].sort((p, q) => p.depth - q.depth)) {
        const x = sx(g.x), y = sy(g.y) - 8;
        c.font = `${g.depth === 1 ? 700 : 600} ${g.depth === 1 ? 12 : 11}px ${SANS}`;
        const txt = g.depth === 1 ? g.label.toUpperCase() : g.label;
        const w = c.measureText(txt).width / 2 + 4;
        const withStats = !!g.stats && z > 0.35;
        const box: [number, number, number, number] = [x - Math.max(w, withStats ? 70 : 0), y - (withStats ? 22 : 8), x + Math.max(w, withStats ? 70 : 0), y + 8];
        if (!free(...box)) continue;
        placed.push(box);
        c.fillStyle = g.css;
        c.fillText(txt, x, y);
        if (withStats && g.stats) {
          c.font = `500 10px ${MONO}`;
          c.fillStyle = 'rgba(160,175,200,0.8)';
          const er = g.stats.rate > 0 ? (g.stats.errRate / g.stats.rate) * 100 : 0;
          c.fillText(`${fmtRate(g.stats.rate)} r/s · ${fmtMs(g.stats.mean)}${er >= 0.1 ? ` · ${er.toFixed(1)}% err` : ''}`, x, y - 14);
        }
      }

      // Node labels: hovered/focused first, then services, then the busiest endpoints, then active users.
      const prio = (n: SceneNode) => (n.id === scene.hover || n.id === scene.focus ? 1e9 : fs?.has(n.id) ? 1e8 : 0)
        + (n.level === 'service' ? 1e7 : n.level === 'endpoint' ? 1e6 + n.rate * 100 : n.active * 1e5);
      const order = [...scene.nodes.values()].sort((p, q) => prio(q) - prio(p));
      for (const n of order) {
        const focused = !!fs && fs.has(n.id);
        const a = n.alpha * (!fs || focused ? 1 : 0.25);
        if (a < 0.05) continue;
        const x = sx(n.x), y = sy(n.y), r = n.r * z;
        const big = n.id === scene.hover || n.id === scene.focus;
        const small = n.level !== 'service';
        // users: like Logstalgia, the label shows up while the user is busy (or when zoomed in / focused)
        let la = a;
        if (n.level === 'user' && !big && !focused && z < 1.1) {
          la = a * Math.min(1, n.active * 1.6);
          if (la < 0.05) continue;
        }
        let label = scene.labelOf(n);
        const max = big ? 60 : n.level === 'user' ? 20 : 28;
        if (label.length > max) label = `${label.slice(0, max - 1)}…`;
        const size = small ? Math.max(9, Math.min(12, 10.5 * Math.sqrt(z))) : Math.max(10, Math.min(14, 12 * Math.sqrt(z)));
        c.font = `${big ? 700 : small ? 500 : 600} ${size}px ${n.level === 'user' && !scene.mode.userNames ? MONO : SANS}`;
        // users stand in a column: their label goes to the left (like Logstalgia's IPs), others below
        const side = n.kind === 'user';
        const lx = side ? x - r - 6 - c.measureText(label).width / 2 : x;
        const ly = side ? y : y + r + (small ? 12 : 21 * Math.min(1, z + 0.3));
        const w = c.measureText(label).width / 2 + 3;
        if (big || free(lx - w, ly - size / 2 - 1, lx + w, ly + size / 2 + 1)) {
          placed.push([lx - w, ly - size / 2 - 1, lx + w, ly + size / 2 + 1]);
          c.fillStyle = `rgba(220,228,240,${(small ? 0.8 : 0.92) * la})`;
          c.fillText(label, lx, ly);
        }
        // Tempo-style stats inside
        if (r > 16 && n.kind !== 'user' && n.kind !== 'cloud') {
          c.font = `600 ${Math.max(9, Math.min(12, r * 0.36))}px ${MONO}`;
          c.fillStyle = `rgba(235,240,250,${0.9 * a})`;
          c.fillText(n.mean != null ? fmtMs(n.mean).replace(' ', '') : '–', x, y - r * 0.2);
          c.fillStyle = `rgba(160,175,200,${0.85 * a})`;
          c.fillText(`${fmtRate(n.rate)} r/s`, x, y + r * 0.24);
        } else if (n.kind === 'cloud' && r > 18) {
          c.font = `700 ${Math.min(13, r * 0.36)}px ${MONO}`;
          c.fillStyle = `rgba(235,240,250,${0.9 * a})`;
          c.fillText(fmtRate(n.outRate), x, y - r * 0.12);
          c.font = `600 ${Math.min(10, r * 0.28)}px ${SANS}`;
          c.fillStyle = `rgba(160,175,200,${0.85 * a})`;
          c.fillText('req/s', x, y + r * 0.28);
        }
      }
    }

    // floating text (span names, status codes)
    for (const t of scene.texts) {
      const k = t.age / t.life;
      const a = k < 0.12 ? k / 0.12 : 1 - Math.pow((k - 0.12) / 0.88, 2);
      c.globalAlpha = Math.max(0, a);
      c.font = `${t.weight} ${t.size * Math.min(1.3, Math.max(0.75, Math.sqrt(z)))}px ${MONO}`;
      if (t.glow) {
        c.shadowColor = t.color;
        c.shadowBlur = 12;
      }
      c.fillStyle = t.color;
      c.fillText(t.str, sx(t.x), sy(t.y));
      c.shadowBlur = 0;
    }
    c.globalAlpha = 1;
  }

  private drawBasic(scene: Scene, sx: (x: number) => number, sy: (y: number) => number, z: number): void {
    const c = this.ctx;
    const fs = scene.focusSet();
    const dim = (id: string) => (!fs || fs.has(id) ? 1 : 0.2);
    // edges
    c.lineWidth = 1;
    for (const e of scene.edges.values()) {
      const a = scene.nodes.get(e.s), b = scene.nodes.get(e.t);
      if (!a || !b) continue;
      const err = e.rate > 0 ? Math.min(1, (e.err / e.rate) * 4) : 0;
      c.strokeStyle = `rgba(${Math.round(70 + 185 * err)},${Math.round(100 - 60 * err)},${Math.round(150 - 110 * err)},${0.35 * Math.min(a.alpha, b.alpha) * Math.min(dim(e.s), dim(e.t))})`;
      c.beginPath();
      for (let i = 0; i < e.pts.length; i += 2) c.lineTo(sx(e.pts[i]), sy(e.pts[i + 1]));
      c.stroke();
    }
    // nodes
    for (const n of scene.nodes.values()) {
      const x = sx(n.x), y = sy(n.y), r = n.r * z, a = n.alpha * dim(n.id);
      if (n.kind === 'cloud') {
        const g = c.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(120,135,175,${0.22 * a})`);
        g.addColorStop(1, 'rgba(120,135,175,0)');
        c.fillStyle = g;
        c.beginPath();
        c.ellipse(x, y, r, r * 0.75, 0, 0, Math.PI * 2);
        c.fill();
        continue;
      }
      nodePath(c, n, x, y, r);
      c.fillStyle = `rgba(6,8,14,${0.9 * a})`;
      c.fill();
      const err = n.rate > 0 ? n.errRate / n.rate : 0;
      c.lineWidth = n.kind === 'user' ? 1.2 : 2.5;
      c.strokeStyle = n.kind === 'user' ? css(n.rgb, a) : err > 0.05 ? `rgba(255,60,80,${a})` : n.kind === 'database' ? `rgba(60,140,255,${a})` : `rgba(60,215,100,${a})`;
      c.stroke();
    }
    // balls
    const tmp = [0, 0, 0, 0];
    for (const b of scene.balls) {
      if (b.phase === 1) continue;
      const req = b.phase === 0;
      const t0 = req ? b.depart : b.ret, t1 = req ? b.arrive : b.back;
      const u = (scene.play - t0) / (t1 - t0);
      if (u < 0 || u > 1) continue;
      scene.ballAt(b, req ? u : 1 - u, req ? 4 : -4, tmp);
      const focus = !fs || (fs.has(b.src) && fs.has(b.dst));
      c.fillStyle = b.err ? '#ff4d5e' : linCss(b.rgb, focus ? 0.95 : 0.15);
      c.beginPath();
      c.arc(sx(tmp[0]), sy(tmp[1]), Math.max(1.5, 3.2 * z), 0, Math.PI * 2);
      c.fill();
    }
    // shockwaves
    for (const r of scene.rings) {
      const k = r.age / r.life;
      c.strokeStyle = linCss(r.rgb, (1 - k) * r.a * 0.8);
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(sx(r.x), sy(r.y), (r.r0 + (r.r1 - r.r0) * (1 - Math.pow(1 - k, 3))) * z, 0, Math.PI * 2);
      c.stroke();
    }
  }
}

const srgb = (v: number) => Math.round(255 * Math.min(1, Math.pow(Math.max(0, v), 1 / 2.2)));
const linCss = (rgb: Rgb, a: number) => `rgba(${srgb(rgb[0])},${srgb(rgb[1])},${srgb(rgb[2])},${a})`;

function nodePath(c: CanvasRenderingContext2D, n: SceneNode, x: number, y: number, r: number): void {
  c.beginPath();
  if (n.kind === 'database') {
    // octagon with flat sides, inradius r
    const R = r / Math.cos(Math.PI / 8);
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 8 + (i * Math.PI) / 4;
      c.lineTo(x + Math.cos(a) * R, y + Math.sin(a) * R);
    }
    c.closePath();
  } else if (n.kind === 'service' || n.kind === 'external') {
    // pointy-top hexagon, inradius r
    const R = r / Math.cos(Math.PI / 6);
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 3;
      c.lineTo(x + Math.cos(a) * R, y + Math.sin(a) * R);
    }
    c.closePath();
  } else {
    c.arc(x, y, r, 0, Math.PI * 2);
  }
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
