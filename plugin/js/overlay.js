// 2D canvas on top of the WebGPU canvas: node labels, Tempo-style stats, floating text.

const fmtRate = (r) => (r >= 100 ? r.toFixed(0) : r >= 10 ? r.toFixed(1) : r.toFixed(2));
export const fmtMs = (ms) => (ms == null ? '–' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : ms >= 100 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(1)} ms`);

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.labels = true;
  }

  resize(w, h, dpr) {
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.dpr = dpr;
    this.w = w;
    this.h = h;
  }

  draw(scene, cam) {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    const z = cam.zoom;
    const sx = (x) => (x - cam.x) * z + this.w / 2;
    const sy = (y) => (y - cam.y) * z + this.h / 2;
    const fs = scene.focusSet();
    c.textAlign = 'center';
    c.textBaseline = 'middle';

    // edge label under the cursor
    if (scene.hoverEdge) {
      const e = scene.edges.get(scene.hoverEdge);
      if (e) {
        const p = [0, 0, 0, 0];
        e.at(0.5, p);
        const txt = `${fmtRate(e.rate)} r/s · ${fmtMs(e.mean)}${e.err > 0 ? ` · ${((e.err / Math.max(e.rate, 1e-9)) * 100).toFixed(1)}% err` : ''}`;
        c.font = '600 11px Inter, system-ui, sans-serif';
        const w = c.measureText(txt).width + 14;
        c.fillStyle = 'rgba(14,16,24,0.88)';
        c.strokeStyle = 'rgba(255,255,255,0.12)';
        roundRect(c, sx(p[0]) - w / 2, sy(p[1]) - 11, w, 22, 6);
        c.fill(); c.stroke();
        c.fillStyle = '#d8e0ee';
        c.fillText(txt, sx(p[0]), sy(p[1]) + 0.5);
      }
    }

    if (this.labels) {
      for (const n of scene.nodes.values()) {
        const a = n.alpha * (!fs || fs.has(n.id) ? 1 : 0.25);
        if (a < 0.05) continue;
        const x = sx(n.x), y = sy(n.y), r = n.r * z;
        // name under the node
        const big = n.id === scene.hover || n.id === scene.focus;
        c.font = `${big ? 700 : 600} ${Math.max(10, Math.min(14, 12 * Math.sqrt(z)))}px Inter, system-ui, sans-serif`;
        c.fillStyle = `rgba(220,228,240,${0.92 * a})`;
        c.fillText(n.id === 'user' ? 'USERS' : n.id, x, y + r + 21 * Math.min(1, z + 0.3));
        // Tempo-style stats inside
        if (r > 16 && n.kind !== 'user') {
          c.font = `600 ${Math.max(9, Math.min(12, r * 0.36))}px "JetBrains Mono", ui-monospace, monospace`;
          c.fillStyle = `rgba(235,240,250,${0.9 * a})`;
          c.fillText(n.mean != null ? fmtMs(n.mean).replace(' ', '') : '–', x, y - r * 0.2);
          c.fillStyle = `rgba(160,175,200,${0.85 * a})`;
          c.fillText(`${fmtRate(n.rate)} r/s`, x, y + r * 0.24);
        } else if (n.kind === 'user' && r > 18) {
          c.font = `700 ${Math.min(13, r * 0.36)}px "JetBrains Mono", ui-monospace, monospace`;
          c.fillStyle = `rgba(235,240,250,${0.9 * a})`;
          c.fillText(`${fmtRate(n.outRate)}`, x, y - r * 0.12);
          c.font = `600 ${Math.min(10, r * 0.28)}px Inter, system-ui, sans-serif`;
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
      c.font = `${t.weight} ${t.size * Math.min(1.3, Math.max(0.75, Math.sqrt(z)))}px "JetBrains Mono", ui-monospace, monospace`;
      if (t.glow) { c.shadowColor = t.color; c.shadowBlur = 12; }
      c.fillStyle = t.color;
      c.fillText(t.str, sx(t.x), sy(t.y));
      c.shadowBlur = 0;
    }
    c.globalAlpha = 1;
  }
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

export { fmtRate };
