// DOM HUD inside the panel: clock, data errors, node tooltip.
import { fmtMs, fmtRate } from './overlay.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class Hud {
  constructor(root, scene, source) {
    this.$ = (cls) => root.querySelector(`.tp-${cls}`);
    this.scene = scene;
    this.source = source;
    this.last = 0;
  }

  update(wall) {
    if (wall - this.last < 200) return;
    this.last = wall;
    const s = this.scene;
    const $ = this.$;

    // clock (playback time)
    if (s.play) {
      const d = new Date(s.play);
      $('date').textContent = d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      $('time').textContent = d.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0').slice(0, 1);
    }
    $('error').textContent = this.source.status.error || '';
    this.tooltip();
  }

  tooltip() {
    const s = this.scene;
    const tip = this.$('tip');
    const n = s.nodes.get(s.hover);
    if (!n) { tip.hidden = true; return; }
    tip.hidden = false;
    const ins = [...s.edges.values()].filter((e) => e.t === n.id).sort((a, b) => b.rate - a.rate);
    const outs = [...s.edges.values()].filter((e) => e.s === n.id).sort((a, b) => b.rate - a.rate);
    const er = n.rate ? (n.errRate / n.rate) * 100 : 0;
    const row = (e, other) => `<tr><td>${esc(other)}</td><td>${fmtRate(e.rate)}/s</td><td>${fmtMs(e.mean)}</td><td class="${e.err > 0 ? 'bad' : ''}">${e.rate ? ((e.err / e.rate) * 100).toFixed(1) : '0.0'}%</td></tr>`;
    tip.innerHTML = `
      <h3><span class="dot" style="background:${n.css}"></span>${esc(n.id)} <small>${n.kind}</small></h3>
      <div class="kv"><div><b>${fmtRate(n.rate || n.outRate)}</b><span>req/s</span></div>
        <div><b class="${er > 1 ? 'bad' : ''}">${er.toFixed(1)}%</b><span>errors</span></div>
        <div><b>${fmtMs(n.mean)}</b><span>mean</span></div>
        <div><b>${n.inflight}</b><span>in flight</span></div></div>
      ${ins.length ? `<table><tr><th>from</th><th></th><th></th><th></th></tr>${ins.slice(0, 6).map((e) => row(e, e.s)).join('')}</table>` : ''}
      ${outs.length ? `<table><tr><th>to</th><th></th><th></th><th></th></tr>${outs.slice(0, 8).map((e) => row(e, e.t)).join('')}</table>` : ''}
      <p class="hint">click to ${s.focus === n.id ? 'unpin' : 'pin'} focus</p>`;
  }
}
