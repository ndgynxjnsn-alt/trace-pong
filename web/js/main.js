import { Renderer } from './gpu.js';
import { Scene } from './scene.js';
import { Overlay } from './overlay.js';
import { Hud } from './hud.js';
import { LiveSource, SimSource } from './data.js';

const params = new URLSearchParams(location.search);
const gpuCanvas = document.getElementById('gpu');
const textCanvas = document.getElementById('text');

async function main() {
  let renderer;
  try {
    renderer = await Renderer.create(gpuCanvas);
  } catch (e) {
    document.getElementById('nogpu').hidden = false;
    document.getElementById('nogpu-msg').textContent = e.message;
    return;
  }
  const scene = new Scene();
  const overlay = new Overlay(textCanvas);
  const source = params.has('sim') ? new SimSource(scene) : new LiveSource(scene, { window: params.get('window') || '1m' });
  const hud = new Hud(scene, source);
  if (params.has('nobloom')) renderer.bloomOn = false;

  const cam = { x: 0, y: 0, zoom: 0.8, auto: true };
  let W = 0, H = 0, dpr = 1;
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    renderer.resize(W * dpr, H * dpr);
    overlay.resize(W, H, dpr);
  };
  window.addEventListener('resize', resize);
  resize();

  // ---- camera: auto-fit until the user takes over ------------------------------
  const fit = (k) => {
    const b = scene.bounds();
    if (!b) return;
    const panel = W > 1100 ? 330 : 20, top = 120, bottom = 70;
    const aw = W - panel - 60, ah = H - top - bottom;
    const zoom = Math.max(0.25, Math.min(1.5, Math.min(aw / (b.x1 - b.x0), ah / (b.y1 - b.y0))));
    const cx = (b.x0 + b.x1) / 2 + (panel - 20) / 2 / zoom;
    const cy = (b.y0 + b.y1) / 2 - (top - bottom) / 2 / zoom;
    cam.zoom += (zoom - cam.zoom) * k;
    cam.x += (cx - cam.x) * k;
    cam.y += (cy - cam.y) * k;
  };
  const toWorld = (px, py) => [(px - W / 2) / cam.zoom + cam.x, (py - H / 2) / cam.zoom + cam.y];

  // ---- input -------------------------------------------------------------------
  let drag = null, moved = false;
  textCanvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
    moved = false;
    textCanvas.setPointerCapture(e.pointerId);
  });
  textCanvas.addEventListener('pointermove', (e) => {
    const tip = document.getElementById('tip');
    tip.style.left = `${Math.min(e.clientX + 18, W - 300)}px`;
    tip.style.top = `${Math.min(e.clientY + 18, H - 260)}px`;
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (moved) {
        cam.auto = false;
        cam.x = drag.cx - dx / cam.zoom;
        cam.y = drag.cy - dy / cam.zoom;
      }
    }
    pick(e.clientX, e.clientY);
  });
  textCanvas.addEventListener('pointerup', (e) => {
    if (!moved) scene.focus = scene.hover && scene.focus !== scene.hover ? scene.hover : null;
    drag = null;
  });
  textCanvas.addEventListener('pointerleave', () => { scene.hover = null; scene.hoverEdge = null; });
  textCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.auto = false;
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    cam.zoom = Math.max(0.15, Math.min(4, cam.zoom * Math.exp(-e.deltaY * 0.0015)));
    cam.x = wx - (e.clientX - W / 2) / cam.zoom;
    cam.y = wy - (e.clientY - H / 2) / cam.zoom;
  }, { passive: false });
  textCanvas.addEventListener('dblclick', () => { cam.auto = true; });

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
    textCanvas.style.cursor = best ? 'pointer' : scene.hoverEdge ? 'help' : drag ? 'grabbing' : 'grab';
  };

  const help = document.getElementById('help');
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    switch (e.key) {
      case ' ': scene.paused = !scene.paused; e.preventDefault(); break;
      case 'b': renderer.bloomOn = !renderer.bloomOn; break;
      case 'l': overlay.labels = !overlay.labels; break;
      case 'f': cam.auto = true; break;
      case '+': case '=': scene.speed = Math.min(4, scene.speed * 1.25); toast(`ball speed ×${scene.speed.toFixed(2)}`); break;
      case '-': scene.speed = Math.max(0.25, scene.speed / 1.25); toast(`ball speed ×${scene.speed.toFixed(2)}`); break;
      case ']': scene.stretch = Math.min(50, scene.stretch * 1.5); toast(`latency stretch ×${scene.stretch.toFixed(1)}`); break;
      case '[': scene.stretch = Math.max(0.5, scene.stretch / 1.5); toast(`latency stretch ×${scene.stretch.toFixed(1)}`); break;
      case 'h': case '?': help.hidden = !help.hidden; break;
      case 'Escape': scene.focus = null; help.hidden = true; break;
      default: return;
    }
  });
  let toastTimer;
  const toast = (msg) => {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1200);
  };

  // ---- loop ----------------------------------------------------------------------
  let last = performance.now(), fpsAcc = 0, fpsN = 0;
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 1) { document.getElementById('fps').textContent = `${Math.round(fpsN / fpsAcc)} fps`; fpsAcc = 0; fpsN = 0; }
    scene.update(Date.now(), dt);
    if (cam.auto) fit(Math.min(1, dt * 2.5));
    scene.build();
    const o = scene.out;
    renderer.render({
      cam, dpr, time: scene.time, dt: scene.paused ? 0 : dt, dim: 0,
      nodes: o.nodes.data, nodeCount: o.nodes.count,
      edges: o.edges.data, edgeCount: o.edges.count,
      under: o.under.data, underCount: o.under.count,
      over: o.over.data, overCount: o.over.count,
      heat: o.heat.data, heatCount: o.heat.count,
      sparks: scene.sparks.data, sparkCount: scene.sparks.count,
    });
    scene.sparks.reset();
    overlay.draw(scene, cam);
    hud.update(now);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  window.tracePong = { scene, cam, renderer, source, hud };
}

function segDist(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const l = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l));
  return Math.hypot(px - x0 - t * dx, py - y0 - t * dy);
}

main();
