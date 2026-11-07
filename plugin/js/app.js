// One trace-pong instance inside a container element (a Grafana panel).
// createTracePong(container, env, options) -> { setOptions(options), destroy() }
import { Renderer } from './gpu.js';
import { Scene } from './scene.js';
import { Overlay } from './overlay.js';
import { Hud } from './hud.js';
import { SimSource } from './data.js';
import { TempoSource } from './tempo.js';

const SOURCE_KEYS = ['mode', 'tempoUrl', 'promUrl', 'traceql', 'labelFilter', 'window', 'maxTraces'];

const HTML = `
  <canvas class="tp-gpu"></canvas>
  <canvas class="tp-text"></canvas>
  <div class="tp-clock"><div class="tp-date">&nbsp;</div><div class="tp-time">--:--:--</div></div>
  <div class="tp-error"></div>
  <div class="tp-foot"><span class="tp-fps"></span><span><kbd>H</kbd> help</span></div>
  <div class="tp-tip" hidden></div>
  <div class="tp-toast"></div>
  <div class="tp-help" hidden>
    <h3>trace-pong</h3>
    <p>Every ball is one call between two services, replayed from Tempo traces. The request flies
      to the callee and the response goes back once the span and its own calls are done. Errors
      explode. Rings show health (green ok / red errors), as in Grafana's service graph. Rates and
      latencies come from Tempo's service-graph metrics.</p>
    <table>
      <tr><td><kbd>drag</kbd> <kbd>ctrl</kbd>+<kbd>wheel</kbd></td><td>pan / zoom (double-click to re-fit)</td></tr>
      <tr><td><kbd>click</kbd></td><td>pin focus on a service</td></tr>
      <tr><td><kbd>space</kbd></td><td>pause</td></tr>
      <tr><td><kbd>+</kbd> <kbd>-</kbd></td><td>ball speed</td></tr>
      <tr><td><kbd>[</kbd> <kbd>]</kbd></td><td>latency stretch (how long balls are held)</td></tr>
      <tr><td><kbd>B</kbd> <kbd>L</kbd> <kbd>F</kbd></td><td>bloom / labels / fit</td></tr>
    </table>
    <p class="hint">Keys work while the panel has focus (click it). Data source, filters and defaults are in the panel options.</p>
  </div>
  <div class="tp-nogpu" hidden><h3>trace-pong needs WebGPU</h3><p class="tp-nogpu-msg"></p>
    <p>Use a recent Chrome or Edge (on Linux, check <code>chrome://gpu</code>), Safari 26, or Firefox with WebGPU enabled.</p></div>
`;

const CSS = `
.tp-root { position: absolute; inset: 0; overflow: hidden; background: #05060b; color: #dfe6f2; outline: none;
  font: 13px/1.4 Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
  --tp-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; --tp-dim: #8b97ad; --tp-bad: #ff4d5e; }
.tp-root canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.tp-root .tp-text { cursor: grab; }
.tp-root .tp-clock { position: absolute; top: 10px; left: 14px; pointer-events: none; }
.tp-root .tp-date { color: var(--tp-dim); font-size: 11px; letter-spacing: 0.3px; }
.tp-root .tp-time { font: 600 18px/1.1 var(--tp-mono); color: #f4f7fc; text-shadow: 0 0 14px rgba(120, 180, 255, 0.35); }
.tp-root.tp-noclock .tp-clock { display: none; }
.tp-root .tp-error { position: absolute; top: 10px; right: 14px; max-width: 60%; text-align: right; color: var(--tp-bad);
  font: 11px var(--tp-mono); pointer-events: none; text-shadow: 0 0 6px #000; }
.tp-root .tp-foot { position: absolute; left: 14px; bottom: 8px; display: flex; gap: 14px; color: var(--tp-dim);
  font: 11px var(--tp-mono); pointer-events: none; }
.tp-root kbd { display: inline-block; padding: 0 5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.18);
  background: rgba(255,255,255,0.06); font: 600 10px var(--tp-mono); color: #dfe6f2; }
.tp-root .tp-tip { position: absolute; z-index: 5; width: 280px; padding: 12px 14px; border-radius: 12px; pointer-events: none;
  background: rgba(14, 16, 26, 0.92); border: 1px solid rgba(255,255,255,0.12); box-shadow: 0 12px 36px rgba(0,0,0,0.5); }
.tp-root .tp-tip h3 { margin: 0 0 8px; font-size: 14px; display: flex; align-items: center; gap: 8px; color: #fff; }
.tp-root .tp-tip h3 small { color: var(--tp-dim); font-weight: 500; margin-left: auto; font-size: 11px; }
.tp-root .tp-tip .dot { width: 10px; height: 10px; border-radius: 50%; box-shadow: 0 0 10px currentColor; }
.tp-root .tp-tip .kv { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 8px; }
.tp-root .tp-tip .kv b { display: block; font: 700 13px var(--tp-mono); }
.tp-root .tp-tip .kv span { color: var(--tp-dim); font-size: 10px; }
.tp-root .tp-tip table { width: 100%; border-collapse: collapse; font: 11px var(--tp-mono); margin-top: 6px; }
.tp-root .tp-tip th { text-align: left; color: var(--tp-dim); font: 600 10px Inter, sans-serif; text-transform: uppercase; letter-spacing: 0.5px; }
.tp-root .tp-tip td { padding: 1px 0; color: #dfe6f2; }
.tp-root .tp-tip td:not(:first-child) { text-align: right; color: var(--tp-dim); }
.tp-root .bad { color: var(--tp-bad) !important; }
.tp-root .hint { color: var(--tp-dim); font-size: 11px; margin: 8px 0 0; opacity: 0.8; }
.tp-root .tp-help { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(520px, 92%);
  max-height: 92%; overflow: auto; padding: 16px 20px; z-index: 10; border-radius: 14px;
  background: rgba(14, 16, 26, 0.94); border: 1px solid rgba(255,255,255,0.12); }
.tp-root .tp-help h3 { margin: 0 0 6px; color: #fff; }
.tp-root .tp-help p { color: #b9c3d6; }
.tp-root .tp-help td { padding: 3px 12px 3px 0; }
.tp-root code { font-family: var(--tp-mono); color: #00e5ff; }
.tp-root .tp-toast { position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%) translateY(16px); opacity: 0;
  transition: all 0.25s; padding: 6px 14px; border-radius: 999px; background: rgba(16, 18, 28, 0.8);
  border: 1px solid rgba(255,255,255,0.08); font: 12px var(--tp-mono); pointer-events: none; }
.tp-root .tp-toast.show { opacity: 1; transform: translateX(-50%); }
.tp-root .tp-nogpu { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; padding: 20px;
  background: #05060b; z-index: 20; }
.tp-root [hidden] { display: none !important; }
`;

function injectCss() {
  if (document.getElementById('tracepong-css')) return;
  const st = document.createElement('style');
  st.id = 'tracepong-css';
  st.textContent = CSS;
  document.head.appendChild(st);
}

export async function createTracePong(container, env, options) {
  injectCss();
  const root = document.createElement('div');
  root.className = 'tp-root';
  root.tabIndex = 0;
  root.innerHTML = HTML;
  container.appendChild(root);
  const $ = (cls) => root.querySelector(`.tp-${cls}`);

  let o = { ...options };
  let destroyed = false;
  let raf = 0;
  const cleanup = [];
  const api = {
    setOptions(next) { o = { ...next }; apply(); },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      cleanup.forEach((f) => f());
      source?.stop();
      renderer?.device.destroy();
      root.remove();
    },
  };

  let renderer;
  try {
    renderer = await Renderer.create($('gpu'));
  } catch (e) {
    $('nogpu').hidden = false;
    $('nogpu-msg').textContent = e.message;
    return api;
  }
  if (destroyed) { renderer.device.destroy(); return api; }

  let scene = new Scene();
  let source = null;
  const overlay = new Overlay($('text'));
  const hud = new Hud(root, scene, { status: { error: null } });
  const cam = { x: 0, y: 0, zoom: 0.8, auto: true };
  let applied = {};

  function apply() {
    renderer.bloomOn = o.bloom !== false;
    overlay.labels = o.labels !== false;
    root.classList.toggle('tp-noclock', o.showClock === false);
    if (SOURCE_KEYS.some((k) => applied[k] !== o[k])) {
      source?.stop();
      const keep = { speed: scene.speed, stretch: scene.stretch, paused: scene.paused };
      scene = Object.assign(new Scene(), keep);
      source = o.mode === 'sim' ? new SimSource(scene) : new TempoSource(scene, env, o);
      hud.scene = scene;
      hud.source = source;
      cam.auto = true;
    }
    if (applied.speed !== o.speed && o.speed) scene.speed = o.speed;
    if (applied.stretch !== o.stretch && o.stretch) scene.stretch = o.stretch;
    applied = { ...o };
  }
  apply();

  let W = 0, H = 0, dpr = 1;
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, root.clientWidth);
    H = Math.max(1, root.clientHeight);
    renderer.resize(W * dpr, H * dpr);
    overlay.resize(W, H, dpr);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(root);
  cleanup.push(() => ro.disconnect());
  resize();

  // ---- camera: auto-fit until the user takes over ------------------------------
  const fit = (k) => {
    const b = scene.bounds();
    if (!b) return;
    const side = 16, top = o.showClock === false ? 24 : 56, bottom = 30;
    const aw = W - 2 * side, ah = H - top - bottom;
    const zoom = Math.max(0.1, Math.min(1.5, Math.min(aw / (b.x1 - b.x0), ah / (b.y1 - b.y0))));
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2 - (top - bottom) / 2 / zoom;
    cam.zoom += (zoom - cam.zoom) * k;
    cam.x += (cx - cam.x) * k;
    cam.y += (cy - cam.y) * k;
  };
  const toWorld = (px, py) => [(px - W / 2) / cam.zoom + cam.x, (py - H / 2) / cam.zoom + cam.y];
  const local = (e) => {
    const r = root.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  // ---- input -------------------------------------------------------------------
  const text = $('text');
  const tip = $('tip');
  let drag = null, moved = false;
  const on = (el, ev, fn, opt) => { el.addEventListener(ev, fn, opt); cleanup.push(() => el.removeEventListener(ev, fn, opt)); };
  on(text, 'pointerdown', (e) => {
    root.focus({ preventScroll: true });
    drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
    moved = false;
    text.setPointerCapture(e.pointerId);
  });
  on(text, 'pointermove', (e) => {
    const [px, py] = local(e);
    tip.style.left = `${Math.max(4, Math.min(px + 18, W - 290))}px`;
    tip.style.top = `${Math.max(4, Math.min(py + 18, H - 250))}px`;
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (moved) {
        cam.auto = false;
        cam.x = drag.cx - dx / cam.zoom;
        cam.y = drag.cy - dy / cam.zoom;
      }
    }
    pick(px, py);
  });
  on(text, 'pointerup', () => {
    if (!moved) scene.focus = scene.hover && scene.focus !== scene.hover ? scene.hover : null;
    drag = null;
  });
  on(text, 'pointerleave', () => { scene.hover = null; scene.hoverEdge = null; });
  // Plain wheel scrolls the dashboard; ctrl/cmd+wheel (and trackpad pinch) zooms.
  on(text, 'wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    cam.auto = false;
    const [px, py] = local(e);
    const [wx, wy] = toWorld(px, py);
    cam.zoom = Math.max(0.1, Math.min(4, cam.zoom * Math.exp(-e.deltaY * 0.0015)));
    cam.x = wx - (px - W / 2) / cam.zoom;
    cam.y = wy - (py - H / 2) / cam.zoom;
  }, { passive: false });
  on(text, 'dblclick', () => { cam.auto = true; });

  const pick = (px, py) => {
    const [wx, wy] = toWorld(px, py);
    let best = null, bd = Infinity;
    for (const n of scene.nodes.values()) {
      const d = Math.hypot(n.x - wx, n.y - wy) - n.r;
      if (d < 14 / cam.zoom && d < bd) { bd = d; best = n.id; }
    }
    scene.hover = best;
    scene.hoverEdge = null;
    if (!best) {
      let ed = 8 / cam.zoom;
      for (const e of scene.edges.values()) {
        for (let i = 0; i < e.pts.length - 2; i += 2) {
          const d = segDist(wx, wy, e.pts[i], e.pts[i + 1], e.pts[i + 2], e.pts[i + 3]);
          if (d < ed) { ed = d; scene.hoverEdge = e.key; }
        }
      }
    }
    text.style.cursor = best ? 'pointer' : scene.hoverEdge ? 'help' : drag ? 'grabbing' : 'grab';
  };

  const help = $('help');
  let toastTimer;
  const toast = (msg) => {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1200);
  };
  // Keys only while the panel has focus, and never leak to Grafana's own shortcuts.
  on(root, 'keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case ' ': scene.paused = !scene.paused; toast(scene.paused ? 'paused' : 'playing'); break;
      case 'b': renderer.bloomOn = !renderer.bloomOn; break;
      case 'l': overlay.labels = !overlay.labels; break;
      case 'f': cam.auto = true; break;
      case '+': case '=': scene.speed = Math.min(4, scene.speed * 1.25); toast(`ball speed ×${scene.speed.toFixed(2)}`); break;
      case '-': scene.speed = Math.max(0.25, scene.speed / 1.25); toast(`ball speed ×${scene.speed.toFixed(2)}`); break;
      case ']': scene.stretch = Math.min(50, scene.stretch * 1.5); toast(`latency stretch ×${scene.stretch.toFixed(1)}`); break;
      case '[': scene.stretch = Math.max(0.5, scene.stretch / 1.5); toast(`latency stretch ×${scene.stretch.toFixed(1)}`); break;
      case 'h': case '?': help.hidden = !help.hidden; break;
      case 'Escape': if (help.hidden && !scene.focus) return; scene.focus = null; help.hidden = true; break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  });
  cleanup.push(() => clearTimeout(toastTimer));

  // ---- loop ----------------------------------------------------------------------
  let last = performance.now(), fpsAcc = 0, fpsN = 0;
  const fpsEl = $('fps');
  const frame = (now) => {
    if (destroyed) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 1) { fpsEl.textContent = `${Math.round(fpsN / fpsAcc)} fps`; fpsAcc = 0; fpsN = 0; }
    scene.update(Date.now(), dt);
    if (cam.auto) fit(Math.min(1, dt * 2.5));
    scene.build();
    const s = scene.out;
    renderer.render({
      cam, dpr, time: scene.time, dt: scene.paused ? 0 : dt, dim: 0,
      nodes: s.nodes.data, nodeCount: s.nodes.count,
      edges: s.edges.data, edgeCount: s.edges.count,
      under: s.under.data, underCount: s.under.count,
      over: s.over.data, overCount: s.over.count,
      heat: s.heat.data, heatCount: s.heat.count,
      sparks: scene.sparks.data, sparkCount: scene.sparks.count,
    });
    scene.sparks.reset();
    overlay.draw(scene, cam);
    hud.update(now);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  api.debug = () => ({ scene, cam, renderer, source });
  return api;
}

function segDist(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const l = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l));
  return Math.hypot(px - x0 - t * dx, py - y0 - t * dy);
}
