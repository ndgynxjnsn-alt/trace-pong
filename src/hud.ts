// DOM HUD inside the panel: clock, data errors, node tooltip.
import { fmtMs, fmtRate } from './overlay';
import type { Edge, Scene } from './scene';
import type { Source } from './types';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

export class Hud {
  private last = 0;
  private readonly date: HTMLElement;
  private readonly time: HTMLElement;
  private readonly error: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly loadingMsg: HTMLElement;

  constructor(root: HTMLElement, public scene: Scene, public source: Source) {
    const $ = (cls: string) => {
      const el = root.querySelector<HTMLElement>(`.tp-${cls}`);
      if (!el) throw new Error(`missing .tp-${cls}`);
      return el;
    };
    this.date = $('date');
    this.time = $('time');
    this.error = $('error');
    this.tip = $('tip');
    this.loading = $('loading');
    this.loadingMsg = $('loading-msg');
  }

  update(wall: number): void {
    if (wall - this.last < 200) return;
    this.last = wall;
    const s = this.scene;
    // clock (playback time)
    if (s.play) {
      const d = new Date(s.play);
      this.date.textContent = d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      this.time.textContent = d.toLocaleTimeString(undefined, { hour12: false });
    }
    this.error.textContent = this.source.status.error || '';
    // loading screen until the first nodes appear
    const empty = !s.hasData;
    this.loading.classList.toggle('done', !empty);
    if (empty) this.loadingMsg.textContent = this.source.status.waiting ?? 'loading…';
    this.tooltip();
  }

  private tooltip(): void {
    const s = this.scene;
    const tip = this.tip;
    const n = s.hover ? s.nodes.get(s.hover) : undefined;
    if (!n) {
      tip.hidden = true;
      return;
    }
    tip.hidden = false;
    const edges = [...s.edges.values()];
    const ins = edges.filter((e) => e.t === n.id).sort((a, b) => b.rate - a.rate);
    const outs = edges.filter((e) => e.s === n.id).sort((a, b) => b.rate - a.rate);
    const er = n.rate ? (n.errRate / n.rate) * 100 : 0;
    const nameOf = (id: string) => {
      const m = s.nodes.get(id);
      return m ? (m.level === 'endpoint' ? `${m.group[m.group.length - 1]} ${m.label}` : s.labelOf(m)) : id;
    };
    const row = (e: Edge, other: string) =>
      `<tr><td>${esc(other)}</td><td>${fmtRate(e.rate)}/s</td><td>${fmtMs(e.mean)}</td><td class="${e.err > 0 ? 'bad' : ''}">${e.rate ? ((e.err / e.rate) * 100).toFixed(1) : '0.0'}%</td></tr>`;
    const table = (title: string, list: Edge[], max: number, other: (e: Edge) => string) =>
      list.length ? `<table><tr><th>${title}</th><th></th><th></th><th></th></tr>${list.slice(0, max).map((e) => row(e, other(e))).join('')}</table>` : '';
    const user = n.user
      ? `<div class="who">${n.user.name ? `<b>${esc(n.user.name)}</b>` : ''}${n.user.username ? `<span>@${esc(n.user.username)}</span>` : ''}
          ${n.user.email ? `<span>${esc(n.user.email)}</span>` : ''}<code>${esc(n.user.id)}</code></div>`
      : '';
    const group = n.group.length && n.level !== 'user' ? `<div class="path">${n.group.map(esc).join(' › ')}</div>` : '';
    const estimated = !n.fromGraph ? '<p class="hint">rates estimated from sampled traces</p>' : '';
    tip.innerHTML = `
      <h3><span class="dot" style="background:${n.css}"></span>${esc(n.level === 'user' ? s.labelOf(n) : n.label)} <small>${n.level === 'endpoint' ? 'endpoint' : n.kind}</small></h3>
      ${group}${user}
      <div class="kv"><div><b>${fmtRate(n.level === 'user' || n.id === 'user' ? n.outRate : n.rate || n.outRate)}</b><span>req/s</span></div>
        <div><b class="${er > 1 ? 'bad' : ''}">${er.toFixed(1)}%</b><span>errors</span></div>
        <div><b>${fmtMs(n.mean)}</b><span>mean</span></div>
        <div><b>${n.inflight}</b><span>in flight</span></div></div>
      ${table('from', ins, 6, (e) => nameOf(e.s))}
      ${table('to', outs, 8, (e) => nameOf(e.t))}
      ${estimated}
      <p class="hint">click to ${s.focus === n.id ? 'unpin' : 'pin'} focus</p>`;
  }
}
