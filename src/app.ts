// One trace-pong instance inside a container element (a Grafana panel).
import { Renderer } from './gpu';
import { Hud } from './hud';
import { Overlay } from './overlay';
import { Scene } from './scene';
import { SimSource } from './sim';
import { TempoSource } from './tempo';
import { Sfx } from './audio';
import { CSS, HTML } from './ui';
import type { Camera, Env, Severity, Source, ViewOptions } from './types';

export interface TracePongHandle {
  setOptions(options: ViewOptions): void;
  destroy(): void;
  /** internals, for tests and the console */
  debug(): { scene: Scene; cam: Camera; renderer: Renderer | null; source: Source | null; sfx: Sfx | null };
}

/** options that need a fresh scene and data source when they change */
const SOURCE_KEYS: (keyof ViewOptions)[] = ['mode', 'tempoUrl', 'promUrl', 'traceql', 'labelFilter', 'window', 'maxTraces'];

function injectCss(): void {
  if (document.getElementById('tracepong-css')) return;
  const st = document.createElement('style');
  st.id = 'tracepong-css';
  st.textContent = CSS;
  document.head.appendChild(st);
}

function el<T extends HTMLElement = HTMLElement>(root: HTMLElement, cls: string): T {
  const e = root.querySelector<T>(`.tp-${cls}`);
  if (!e) throw new Error(`missing .tp-${cls}`);
  return e;
}

/** Mount trace-pong into `container`. Resolves once WebGPU is set up (or has failed visibly). */
export async function createTracePong(container: HTMLElement, env: Env, options: ViewOptions): Promise<TracePongHandle> {
  injectCss();
  const root = document.createElement('div');
  root.className = 'tp-root';
  root.tabIndex = 0;
  root.innerHTML = HTML;
  container.appendChild(root);

  let renderer: Renderer;
  try {
    renderer = await Renderer.create(el<HTMLCanvasElement>(root, 'gpu'));
  } catch (e) {
    el(root, 'nogpu').hidden = false;
    el(root, 'nogpu-msg').textContent = e instanceof Error ? e.message : String(e);
    const scene = new Scene();
    return {
      setOptions() {},
      destroy: () => root.remove(),
      debug: () => ({ scene, cam: { x: 0, y: 0, zoom: 1, auto: true }, renderer: null, source: null, sfx: null }),
    };
  }
  const tp = new TracePong(root, renderer, env, options);
  return {
    setOptions: (o) => tp.setOptions(o),
    destroy: () => tp.destroy(),
    debug: () => ({ scene: tp.scene, cam: tp.cam, renderer, source: tp.source, sfx: tp.sfx }),
  };
}

class TracePong {
  scene = new Scene();
  source: Source | null = null;
  readonly cam: Camera = { x: 0, y: 0, zoom: 0.8, auto: true };
  readonly sfx = new Sfx();
  private readonly overlay: Overlay;
  private readonly hud: Hud;
  private o: ViewOptions;
  private applied: Partial<ViewOptions> = {};
  private destroyed = false;
  private raf = 0;
  private readonly cleanup: (() => void)[] = [];
  private W = 0;
  private H = 0;
  private dpr = 1;
  private drag: { x: number; y: number; cx: number; cy: number } | null = null;
  private moved = false;
  private toastTimer?: ReturnType<typeof setTimeout>;
  private hintAt = 0;
  private readonly text: HTMLCanvasElement;
  private readonly tip: HTMLElement;
  private readonly help: HTMLElement;
  private readonly soundBtn: HTMLElement;

  constructor(private readonly root: HTMLElement, private readonly renderer: Renderer, private readonly env: Env, options: ViewOptions) {
    this.o = { ...options };
    this.text = el<HTMLCanvasElement>(root, 'text');
    this.tip = el(root, 'tip');
    this.help = el(root, 'help');
    const soundBtn = root.querySelector<HTMLElement>('.tp-tools [data-act=sound]');
    if (!soundBtn) throw new Error('missing sound button');
    this.soundBtn = soundBtn;
    this.overlay = new Overlay(this.text);
    this.hud = new Hud(root, this.scene, { status: { error: null }, stop() {} });
    this.apply();

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(root);
    this.cleanup.push(() => ro.disconnect());
    this.resize();
    this.bindInput();
    this.restoreSound();

    let last = performance.now(), fpsAcc = 0, fpsN = 0;
    const fpsEl = el(root, 'fps');
    const frame = (now: number) => {
      if (this.destroyed) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      fpsAcc += dt;
      fpsN++;
      if (fpsAcc > 1) {
        fpsEl.textContent = `${Math.round(fpsN / fpsAcc)} fps`;
        fpsAcc = 0;
        fpsN = 0;
      }
      this.frame(dt, now);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  setOptions(next: ViewOptions): void {
    this.o = { ...next };
    this.apply();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.toastTimer);
    this.cleanup.forEach((f) => f());
    this.source?.stop();
    this.renderer.device.destroy();
    this.sfx.destroy();
    this.root.remove();
  }

  private apply(): void {
    const o = this.o;
    this.renderer.bloomOn = o.bloom;
    this.overlay.labels = o.labels;
    this.root.classList.toggle('tp-noclock', !o.showClock);
    if (SOURCE_KEYS.some((k) => this.applied[k] !== o[k])) {
      this.source?.stop();
      const old = this.scene;
      const scene = new Scene();
      scene.speed = old.speed;
      scene.stretch = old.stretch;
      scene.paused = old.paused;
      scene.sfx = (sev: Severity, wx: number) => this.sfx.play(sev, ((wx - this.cam.x) * this.cam.zoom) / Math.max(1, this.W / 2));
      this.scene = scene;
      this.source = o.mode === 'sim' ? new SimSource(scene) : new TempoSource(scene, this.env, o);
      this.hud.scene = scene;
      this.hud.source = this.source;
      this.cam.auto = true;
    }
    if (this.applied.speed !== o.speed && o.speed) this.scene.speed = o.speed;
    if (this.applied.stretch !== o.stretch && o.stretch) this.scene.stretch = o.stretch;
    this.applied = { ...o };
  }

  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = Math.max(1, this.root.clientWidth);
    this.H = Math.max(1, this.root.clientHeight);
    this.renderer.resize(this.W * this.dpr, this.H * this.dpr);
    this.overlay.resize(this.W, this.H, this.dpr);
  }

  private frame(dt: number, now: number): void {
    const scene = this.scene;
    scene.update(Date.now(), dt);
    if (this.cam.auto) this.fit(Math.min(1, dt * 2.5));
    scene.build();
    const s = scene.out;
    this.renderer.render({
      cam: this.cam, dpr: this.dpr, time: scene.time, dt: scene.paused ? 0 : dt, dim: 0,
      nodes: s.nodes.data, nodeCount: s.nodes.count,
      edges: s.edges.data, edgeCount: s.edges.count,
      under: s.under.data, underCount: s.under.count,
      over: s.over.data, overCount: s.over.count,
      heat: s.heat.data, heatCount: s.heat.count,
      sparks: scene.sparks.data, sparkCount: scene.sparks.count,
    });
    scene.sparks.reset();
    this.overlay.draw(scene, this.cam);
    this.hud.update(now);
  }

  // ---- camera: auto-fit until the user takes over ------------------------------
  private fit(k: number): void {
    const b = this.scene.bounds();
    if (!b) return;
    const cam = this.cam;
    const side = 16, top = this.o.showClock ? 56 : 24, bottom = 30;
    const aw = this.W - 2 * side, ah = this.H - top - bottom;
    const zoom = Math.max(0.1, Math.min(1.5, Math.min(aw / (b.x1 - b.x0), ah / (b.y1 - b.y0))));
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2 - (top - bottom) / 2 / zoom;
    cam.zoom += (zoom - cam.zoom) * k;
    cam.x += (cx - cam.x) * k;
    cam.y += (cy - cam.y) * k;
  }

  private toWorld(px: number, py: number): [number, number] {
    return [(px - this.W / 2) / this.cam.zoom + this.cam.x, (py - this.H / 2) / this.cam.zoom + this.cam.y];
  }

  private local(e: MouseEvent): [number, number] {
    const r = this.root.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private zoomAt(factor: number, px = this.W / 2, py = this.H / 2): void {
    const cam = this.cam;
    cam.auto = false;
    const [wx, wy] = this.toWorld(px, py);
    cam.zoom = Math.max(0.1, Math.min(4, cam.zoom * factor));
    cam.x = wx - (px - this.W / 2) / cam.zoom;
    cam.y = wy - (py - this.H / 2) / cam.zoom;
  }

  private pick(px: number, py: number): void {
    const scene = this.scene;
    const [wx, wy] = this.toWorld(px, py);
    let best: string | null = null, bd = Infinity;
    for (const n of scene.nodes.values()) {
      const d = Math.hypot(n.x - wx, n.y - wy) - n.r;
      if (d < 14 / this.cam.zoom && d < bd) {
        bd = d;
        best = n.id;
      }
    }
    scene.hover = best;
    scene.hoverEdge = null;
    if (!best) {
      let ed = 8 / this.cam.zoom;
      for (const e of scene.edges.values()) {
        for (let i = 0; i < e.pts.length - 2; i += 2) {
          const d = segDist(wx, wy, e.pts[i], e.pts[i + 1], e.pts[i + 2], e.pts[i + 3]);
          if (d < ed) {
            ed = d;
            scene.hoverEdge = e.key;
          }
        }
      }
    }
    this.text.style.cursor = best ? 'pointer' : scene.hoverEdge ? 'help' : this.drag ? 'grabbing' : 'grab';
  }

  private toast(msg: string): void {
    const t = el(this.root, 'toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('show'), 1200);
  }

  private on<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K,
    fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts);
    this.cleanup.push(() => target.removeEventListener(type, fn, opts));
  }

  private toggleFull(): void {
    if (document.fullscreenElement === this.root) void document.exitFullscreen();
    else {
      this.root.requestFullscreen()
        .then(() => this.root.focus({ preventScroll: true }))
        .catch((err: Error) => this.toast(`full screen not allowed: ${err.message}`));
    }
  }

  // Sound needs a user gesture to start (autoplay rules); the on/off choice is remembered per browser.
  private setSound(on: boolean): void {
    this.sfx.setOn(on);
    this.soundBtn.classList.toggle('tp-active', on);
    try {
      localStorage.setItem('tracepong.sound', on ? '1' : '0');
    } catch {
      // storage blocked
    }
  }

  private toggleSound(): void {
    this.setSound(!this.sfx.on);
    this.toast(this.sfx.on ? 'sound on' : 'sound off');
  }

  private restoreSound(): void {
    let want = false;
    try {
      want = localStorage.getItem('tracepong.sound') === '1';
    } catch {
      // storage blocked
    }
    this.soundBtn.classList.toggle('tp-active', want);
    if (!want) return;
    const start = () => {
      if (!this.sfx.on && this.soundBtn.classList.contains('tp-active')) this.sfx.setOn(true);
    };
    this.on(this.root, 'pointerdown', start, { once: true });
    this.on(this.root, 'keydown', start, { once: true });
  }

  private bindInput(): void {
    const { root, text, tip, help, cam } = this;
    this.on(text, 'pointerdown', (e) => {
      root.focus({ preventScroll: true });
      this.drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
      this.moved = false;
      text.setPointerCapture(e.pointerId);
    });
    this.on(text, 'pointermove', (e) => {
      const [px, py] = this.local(e);
      tip.style.left = `${Math.max(4, Math.min(px + 18, this.W - 290))}px`;
      tip.style.top = `${Math.max(4, Math.min(py + 18, this.H - 250))}px`;
      const drag = this.drag;
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) this.moved = true;
        if (this.moved) {
          cam.auto = false;
          cam.x = drag.cx - dx / cam.zoom;
          cam.y = drag.cy - dy / cam.zoom;
        }
      }
      this.pick(px, py);
    });
    this.on(text, 'pointerup', () => {
      const s = this.scene;
      if (!this.moved) s.focus = s.hover && s.focus !== s.hover ? s.hover : null;
      this.drag = null;
    });
    this.on(text, 'pointerleave', () => {
      this.scene.hover = null;
      this.scene.hoverEdge = null;
    });
    // The wheel zooms once the panel is active (clicked), in full screen, or with ctrl/cmd (and
    // trackpad pinch). Otherwise it scrolls the dashboard as usual, with a hint.
    this.on(text, 'wheel', (e) => {
      const active = root.contains(document.activeElement) || document.fullscreenElement === root;
      if (!active && !e.ctrlKey && !e.metaKey) {
        if (performance.now() - this.hintAt > 4000) {
          this.hintAt = performance.now();
          this.toast('click the panel (or hold ctrl) to zoom');
        }
        return;
      }
      e.preventDefault();
      const [px, py] = this.local(e);
      this.zoomAt(Math.exp(-e.deltaY * 0.0015), px, py);
    }, { passive: false });
    this.on(text, 'dblclick', () => { cam.auto = true; });

    const tools = el(root, 'tools');
    this.on(tools, 'click', (e) => {
      const act = (e.target as Element | null)?.closest<HTMLElement>('button')?.dataset.act;
      if (act === 'in') this.zoomAt(1.25);
      else if (act === 'out') this.zoomAt(0.8);
      else if (act === 'fit') cam.auto = true;
      else if (act === 'full') this.toggleFull();
      else if (act === 'sound') this.toggleSound();
    });
    this.on(tools, 'dblclick', (e) => e.stopPropagation());

    // Keys only while the panel has focus, and never leak to Grafana's own shortcuts.
    this.on(root, 'keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const s = this.scene;
      switch (e.key) {
        case ' ': s.paused = !s.paused; this.toast(s.paused ? 'paused' : 'playing'); break;
        case 'b': this.renderer.bloomOn = !this.renderer.bloomOn; break;
        case 'l': this.overlay.labels = !this.overlay.labels; break;
        case 'f': cam.auto = true; break;
        case 'F': this.toggleFull(); break;
        case 'm': this.toggleSound(); break;
        case '+': case '=': s.speed = Math.min(4, s.speed * 1.25); this.toast(`ball speed ×${s.speed.toFixed(2)}`); break;
        case '-': s.speed = Math.max(0.25, s.speed / 1.25); this.toast(`ball speed ×${s.speed.toFixed(2)}`); break;
        case ']': s.stretch = Math.min(50, s.stretch * 1.5); this.toast(`latency stretch ×${s.stretch.toFixed(1)}`); break;
        case '[': s.stretch = Math.max(0.5, s.stretch / 1.5); this.toast(`latency stretch ×${s.stretch.toFixed(1)}`); break;
        case 'h': case '?': help.hidden = !help.hidden; break;
        case 'Escape':
          if (help.hidden && !s.focus) return;
          s.focus = null;
          help.hidden = true;
          break;
        default: return;
      }
      e.preventDefault();
      e.stopPropagation();
    });
  }
}

function segDist(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0;
  const l = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l));
  return Math.hypot(px - x0 - t * dx, py - y0 - t * dy);
}
