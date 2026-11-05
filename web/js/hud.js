// DOM HUD: clock, live status, stat tiles, route leaderboard (Logstalgia's URL list), alerts, tooltip.
import { fmtMs, fmtRate } from './overlay.js';
import { css } from './scene.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class Hud {
  constructor(scene, source) {
    this.scene = scene;
    this.source = source;
    this.last = 0;
    this.baseline = new Map();
    $('mode').textContent = source.label;
  }

  update(wall) {
    if (wall - this.last < 200) return;
    this.last = wall;
    const s = this.scene;

    // clock (playback time)
    if (s.play) {
      const d = new Date(s.play);
      $('date').textContent = d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      $('time').textContent = d.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0').slice(0, 1);
    }
    const st = this.source.status;
    const lagS = s.delay != null ? (s.delay / 1000).toFixed(1) : '…';
    const ok = st.stream === 'ok' && st.graph !== 'error';
    $('live').className = `pill ${s.paused ? 'paused' : ok ? 'ok' : 'bad'}`;
    $('lag').textContent = s.paused ? 'PAUSED' : this.source.label === 'SIM' ? 'simulated' : `−${lagS}s`;
    $('error').textContent = st.error || (st.stream !== 'ok' ? `stream ${st.stream}` : '');

    // tiles from the last 10 s of played hops
    const win = 10;
    let entries = 0, errs = 0, lat = 0;
    for (const r of s.recent) {
      if (r[1]) { entries++; lat += r[6]; if (r[2]) errs++; }
    }
    $('t-rps').textContent = fmtRate(entries / win);
    $('t-hops').textContent = fmtRate(s.recent.length / win);
    $('t-err').textContent = entries ? `${((errs / entries) * 100).toFixed(1)}%` : '–';
    $('t-err').parentElement.classList.toggle('alarm', entries > 0 && errs / entries > 0.03);
    $('t-lat').textContent = entries ? fmtMs(lat / entries) : '–';
    $('t-nodes').textContent = `${s.nodes.size} services · ${s.edges.size} edges`;
    $('t-sample').textContent = st.found ? `sampling ${st.sampled}/${st.found} traces/poll` : '';

    // route leaderboard over the last 30 s
    const horizon = s.play - 30000;
    const rows = [];
    for (const r of s.routes.values()) {
      while (r.hits.length && r.hits[0] < horizon) r.hits.shift();
      while (r.errs.length && r.errs[0] < horizon) r.errs.shift();
      if (r.hits.length) rows.push(r);
      else s.routes.delete(r.name);
    }
    rows.sort((a, b) => b.hits.length - a.hits.length);
    const max = rows[0]?.hits.length || 1;
    $('routes').innerHTML = rows.slice(0, 14).map((r) => {
      const h = hue(r.name);
      return `<li><span class="bar" style="width:${(r.hits.length / max) * 100}%;background:${h}"></span>
        <span class="name" style="color:${h}">${esc(r.name)}</span>
        <span class="n">${r.hits.length}${r.errs.length ? ` <b>${r.errs.length}✕</b>` : ''}</span></li>`;
    }).join('');

    // alerts: error rate or latency far above its own baseline
    const alerts = [];
    for (const n of s.nodes.values()) {
      if (n.kind === 'user' || !n.rate) continue;
      const er = n.errRate / n.rate;
      const b = this.baseline.get(n.id);
      if (n.mean != null) {
        if (b == null) this.baseline.set(n.id, n.mean);
        else if (n.mean < b * 2) this.baseline.set(n.id, b * 0.97 + n.mean * 0.03);
      }
      if (er > 0.05 && n.rate > 0.05) alerts.push({ id: n.id, txt: `${(er * 100).toFixed(0)}% errors`, sev: 'err', color: n.css });
      else if (b != null && n.mean > b * 3 && n.mean > 20) alerts.push({ id: n.id, txt: `latency ${fmtMs(n.mean)} (×${(n.mean / b).toFixed(1)})`, sev: 'warn', color: n.css });
    }
    $('alerts').innerHTML = alerts.map((a) => `<li class="${a.sev}"><i></i><b style="color:${a.color}">${esc(a.id)}</b> ${esc(a.txt)}</li>`).join('');

    this.tooltip();
  }

  tooltip() {
    const s = this.scene;
    const tip = $('tip');
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

const hueCache = new Map();
function hue(name) {
  if (!hueCache.has(name)) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    hueCache.set(name, `hsl(${h % 360} 85% 68%)`);
  }
  return hueCache.get(name);
}

export { css };
