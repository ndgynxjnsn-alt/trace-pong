// One trace-pong instance inside a container element (a Grafana panel).
import { Renderer } from './gpu';
import { Hud } from './hud';
import { Overlay } from './overlay';
import { Scene } from './scene';
import { SimSource } from './sim';
import { TempoSource } from './tempo';
import { Sfx } from './audio';
import { CSS, HTML } from './ui';
import { parseRenames } from './rename';
import { debugHtml, debugReport, debugText, type FrameTimes } from './debug';
import type { Camera, Env, Severity, Source, ViewMode, ViewOptions } from './types';

export interface TracePongHandle {
  setOptions(options: ViewOptions): void;
  destroy(): void;
  /** internals, for tests and the console */
  debug(): { scene: Scene; cam: Camera; renderer: Renderer | null; source: Source | null; sfx: Sfx | null };
}

/** options that need a fresh scene and data source when they change */
const SOURCE_KEYS: (keyof ViewOptions)[] = ['mode', 'tempoUrl', 'promUrl', 'traceql', 'labelFilter', 'window', 'maxTraces', 'sampling', 'interpolate', 'rename'];

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

  // Without WebGPU (or when it fails to start) trace-pong still runs, drawn with a plain 2D canvas.
  let renderer: Renderer | null = null;
  let failure: string | null = null;
  if (crashedLastTime()) {
    failure = 'WebGPU is off because the last session ended unexpectedly while it was drawing (a GPU or browser crash?). '
      + 'Retry WebGPU to turn it back on.';
    console.warn('trace-pong:', failure);
  } else {
    try {
      renderer = await Renderer.create(el<HTMLCanvasElement>(root, 'gpu'));
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
      console.warn('trace-pong:', failure);
    }
  }
  const tp = new TracePong(root, renderer, env, options, failure);
  return {
    setOptions: (o) => tp.setOptions(o),
    destroy: () => tp.destroy(),
    debug: () => ({ scene: tp.scene, cam: tp.cam, renderer: tp.gpu, source: tp.source, sfx: tp.sfx }),
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

  private mode: ViewMode = loadViewMode();
  private idleFrames = 0;
  private lost = false;
  private failure: string | null;
  private fps = 0;
  private readonly times: FrameTimes = { update: 0, build: 0, encode: 0, overlay: 0, interval: 16.7 };
  /** GPU canvas resolution relative to the screen; lowered automatically while fps stays low */
  private renderScale = 1;
  private scaleNote = '';
  private scaleTest: { prev: number; fpsBefore: number; wait: number } | null = null;
  private scaleSettled = false;
  private lowSeconds = 0;
  private readonly debugEl: HTMLElement;
  private debugAt = 0;
  private readonly instanceId = Math.random().toString(36).slice(2);

  constructor(private readonly root: HTMLElement, private renderer: Renderer | null, private readonly env: Env, options: ViewOptions,
    failure: string | null) {
    this.o = { ...options };
    this.failure = failure;
    this.debugEl = el(root, 'debug');
    if (this.renderer) this.watchDevice();
    else this.fallback(failure ?? 'WebGPU is not available');
    this.text = el<HTMLCanvasElement>(root, 'text');
    this.tip = el(root, 'tip');
    this.help = el(root, 'help');
    const soundBtn = root.querySelector<HTMLElement>('.tp-tools [data-act=sound]');
    if (!soundBtn) throw new Error('missing sound button');
    this.soundBtn = soundBtn;
    this.overlay = new Overlay(this.text);
    this.hud = new Hud(root, this.scene, { status: { error: null, waiting: null }, stop() {} });
    this.apply();

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(root);
    this.cleanup.push(() => ro.disconnect());
    this.resize();
    this.bindInput();
    this.restoreSound();
    this.syncToggles();

    let last = performance.now(), fpsStart = last, fpsN = 0;
    const fpsEl = el(root, 'fps');
    const frame = (now: number) => {
      if (this.destroyed) return;
      const real = now - last;
      const dt = Math.min(0.05, real / 1000);
      last = now;
      this.times.interval += (real - this.times.interval) * 0.1;
      fpsN++;
      if (now - fpsStart > 1000) {
        this.fps = (fpsN * 1000) / (now - fpsStart);
        fpsEl.textContent = `${Math.round(this.fps)} fps`;
        fpsStart = now;
        fpsN = 0;
        this.adaptScale();
      }
      this.frame(dt, now);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);

    const beat = () => heartbeat(this.instanceId, !!this.gpu && !document.hidden && !this.destroyed);
    const timer = setInterval(beat, 1000);
    const leave = () => heartbeat(this.instanceId, false);
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', beat);
    this.cleanup.push(() => {
      clearInterval(timer);
      window.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', beat);
      leave();
    });
  }

  /**
   * On device loss: stop using the dead device (labels, tooltips and data keep going), try one
   * automatic restart, then offer a button.
   */
  private watchDevice(): void {
    if (!this.renderer) return;
    this.renderer.onLost = (msg) => {
      if (this.destroyed) return;
      this.lost = true;
      el(this.root, 'lost-msg').textContent = msg;
      if (this.autoRestarts++ < 1) setTimeout(() => void this.restartRenderer(), 1000);
      else this.fallback(msg);
    };
  }

  /** WebGPU unusable: keep going with the 2D view and say so, with a retry button */
  private fallback(msg: string): void {
    this.lost = true;
    this.failure = msg;
    el(this.root, 'gpu').style.visibility = 'hidden';   // no stale GPU frame under the 2D view
    el(this.root, 'lost-title').textContent = 'WebGPU unavailable, simple 2D view';
    el(this.root, 'lost-msg').textContent = msg;
    el(this.root, 'lost').hidden = false;
  }

  get gpu(): Renderer | null {
    return this.lost ? null : this.renderer;
  }

  private autoRestarts = 0;

  private async restartRenderer(): Promise<void> {
    try {
      const r = await Renderer.create(el<HTMLCanvasElement>(this.root, 'gpu'));
      if (this.renderer && this.renderer !== r) this.renderer.device.destroy();
      this.renderer = r;
      this.watchDevice();
      this.lost = false;
      this.failure = null;
      el(this.root, 'gpu').style.visibility = '';
      this.apply();
      this.resize();
      el(this.root, 'lost').hidden = true;
    } catch (e) {
      this.fallback(e instanceof Error ? e.message : String(e));
    }
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
    this.renderer?.device.destroy();
    this.sfx.destroy();
    this.root.remove();
  }

  private apply(): void {
    const o = this.o;
    if (this.renderer) this.renderer.bloomOn = o.bloom;
    this.overlay.labels = o.labels;
    this.root.classList.toggle('tp-noclock', !o.showClock);
    if (SOURCE_KEYS.some((k) => this.applied[k] !== o[k])) {
      this.source?.stop();
      const old = this.scene;
      const scene = new Scene();
      scene.speed = old.speed;
      scene.stretch = old.stretch;
      scene.paused = old.paused;
      scene.mode = { ...this.mode };
      scene.renames = parseRenames(o.rename);
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
    const W = Math.max(1, this.root.clientWidth), H = Math.max(1, this.root.clientHeight);
    if (W !== this.W || H !== this.H) {
      // new size (e.g. full screen): start over at full resolution
      this.renderScale = 1;
      this.scaleNote = '';
      this.scaleTest = null;
      this.scaleSettled = false;
      this.lowSeconds = 0;
    }
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = W;
    this.H = H;
    const k = this.dpr * this.renderScale;
    if (!this.lost) this.renderer?.resize(this.W * k, this.H * k);
    this.overlay.resize(this.W, this.H, this.dpr);
  }

  private frame(dt: number, now: number): void {
    const scene = this.scene;
    const t = this.times;
    const ema = (k: keyof FrameTimes, since: number) => {
      const end = performance.now();
      t[k] += (end - since - t[k]) * 0.1;
      return end;
    };
    let t0 = performance.now();
    scene.update(Date.now(), dt);
    t0 = ema('update', t0);
    this.hud.update(now);
    if (!this.debugEl.hidden && now - this.debugAt > 500) this.showDebug(now);
    // nothing to show yet: keep the loading screen and draw the background at a few fps only
    if (!scene.hasData && this.idleFrames++ % 8 !== 0) return;
    // the camera holds still while the layout re-arranges, then settles on the new picture
    if (this.cam.auto && !scene.arranging) this.fit(Math.min(1, dt * 1.5));
    t0 = performance.now();
    scene.build();
    t0 = ema('build', t0);
    const gpu = this.gpu;
    let drawn = !gpu;
    if (gpu) {
      try {
        drawn = this.renderGpu(gpu, dt);
      } catch (e) {
        // never let a GPU problem take the panel down
        this.fallback(e instanceof Error ? e.message : String(e));
        drawn = true;
      }
    }
    t0 = ema('encode', t0);
    // sparks wait for the next frame the GPU takes, but never pile up
    if (drawn || scene.sparks.count > 20000) scene.sparks.reset();
    this.overlay.draw(scene, this.cam, !gpu);
    ema('overlay', t0);
  }

  /**
   * Called once a second. While fps stays below 45 for 3 s, lower the GPU resolution (0.75, then
   * 0.5) and keep it only if fps improves by at least 10%; otherwise go back and stop trying,
   * because the time is lost somewhere resolution does not matter.
   */
  private adaptScale(): void {
    if (this.scaleSettled || !this.gpu || !this.scene.hasData || document.hidden || this.scene.paused) return;
    const fps = this.fps;
    const test = this.scaleTest;
    if (test) {
      if (--test.wait > 0) return;
      this.scaleTest = null;
      if (fps < test.fpsBefore * 1.1) {
        this.renderScale = test.prev;
        this.scaleNote = `(lower resolution did not help: ${Math.round(test.fpsBefore)} → ${Math.round(fps)} fps)`;
        this.scaleSettled = true;
        this.resize();
      } else {
        this.scaleNote = `(lowered automatically: ${Math.round(test.fpsBefore)} → ${Math.round(fps)} fps)`;
      }
      return;
    }
    if (fps >= 45) {
      this.lowSeconds = 0;
      return;
    }
    if (++this.lowSeconds < 3) return;
    this.lowSeconds = 0;
    if (this.renderScale <= 0.5) {
      this.scaleSettled = true;
      return;
    }
    this.scaleTest = { prev: this.renderScale, fpsBefore: fps, wait: 2 };
    this.renderScale = this.renderScale > 0.75 ? 0.75 : 0.5;
    this.scaleNote = '(testing a lower resolution…)';
    this.resize();
  }

  private debugReport() {
    return debugReport({
      gpu: this.gpu, renderer: this.renderer, failure: this.failure, fps: this.fps, times: this.times,
      css: [this.W, this.H], dpr: this.dpr, renderScale: this.renderScale, scaleNote: this.scaleNote,
      bloom: this.renderer?.bloomOn ?? false, scene: this.scene, source: this.source,
    });
  }

  private showDebug(now: number): void {
    this.debugAt = now;
    const body = el(this.root, 'debug-body');
    // don't replace the text while the user is selecting it
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && this.debugEl.contains(sel.anchorNode)) return;
    body.innerHTML = debugHtml(this.debugReport());
  }

  private renderGpu(gpu: Renderer, dt: number): boolean {
    const scene = this.scene;
    const s = scene.out;
    return gpu.render({
      cam: this.cam, dpr: this.dpr * this.renderScale, time: scene.time, dt: scene.paused ? 0 : dt, dim: 0, cell: scene.cellSize,
      nodes: s.nodes.data, nodeCount: s.nodes.count,
      edges: s.edges.data, edgeCount: s.edges.count,
      under: s.under.data, underCount: s.under.count,
      over: s.over.data, overCount: s.over.count,
      heat: s.heat.data, heatCount: s.heat.count,
      hulls: s.hulls.data, hullCount: s.hulls.count,
      sparks: scene.sparks.data, sparkCount: scene.sparks.count,
    });
  }

  // ---- view toggles (help overlay, keys E / U / R), remembered per browser ----------------
  private setMode(m: ViewMode, msg: string): void {
    // switching nodes or layout moves everything: follow it with the camera
    if (m.endpoints !== this.mode.endpoints || m.layout !== this.mode.layout) this.cam.auto = true;
    this.mode = m;
    this.scene.setMode(m);
    saveViewMode(m);
    this.syncToggles();
    this.toast(msg);
  }

  private toggle(which: 'endpoints' | 'userNames' | 'radial'): void {
    const m = { ...this.mode };
    if (which === 'endpoints') {
      m.endpoints = !m.endpoints;
      this.setMode(m, m.endpoints ? 'endpoints as nodes' : 'services as nodes');
    } else if (which === 'userNames') {
      m.userNames = !m.userNames;
      this.setMode(m, m.userNames ? 'user names' : 'user ids');
    } else {
      m.layout = m.layout === 'radial' ? 'flow' : 'radial';
      this.setMode(m, m.layout === 'radial' ? 'radial layout' : 'left-to-right layout');
    }
  }

  private syncToggles(): void {
    const on = { endpoints: this.mode.endpoints, userNames: this.mode.userNames, radial: this.mode.layout === 'radial' };
    for (const b of this.root.querySelectorAll<HTMLElement>('.tp-toggles [data-view]')) {
      b.classList.toggle('on', !!on[b.dataset.view as keyof typeof on]);
    }
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
    this.on(el(root, 'help'), 'click', (e) => {
      const v = (e.target as Element | null)?.closest<HTMLElement>('[data-view]')?.dataset.view;
      if (v === 'endpoints' || v === 'userNames' || v === 'radial') this.toggle(v);
    });
    this.on(el(root, 'restart'), 'click', () => void this.restartRenderer());
    this.on(el(root, 'debug-copy'), 'click', () => {
      const text = debugText(this.debugReport());
      navigator.clipboard.writeText(text).then(() => this.toast('debug info copied'), () => {
        console.log(text);
        this.toast('copy blocked: printed to the browser console');
      });
    });
    for (const t of ['pointerdown', 'wheel', 'dblclick'] as const) this.on(this.debugEl, t, (e) => e.stopPropagation());

    // Keys only while the panel has focus, and never leak to Grafana's own shortcuts.
    this.on(root, 'keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const s = this.scene;
      switch (e.key) {
        case ' ': s.paused = !s.paused; this.toast(s.paused ? 'paused' : 'playing'); break;
        case 'b': if (this.renderer) this.renderer.bloomOn = !this.renderer.bloomOn; break;
        case 'l': this.overlay.labels = !this.overlay.labels; break;
        case 'f': cam.auto = true; break;
        case 'F': this.toggleFull(); break;
        case 'm': this.toggleSound(); break;
        case 'e': this.toggle('endpoints'); break;
        case 'u': this.toggle('userNames'); break;
        case 'r': this.toggle('radial'); break;
        case '+': case '=': s.speed = Math.min(4, s.speed * 1.25); this.toast(`ball speed ×${s.speed.toFixed(2)}`); break;
        case '-': s.speed = Math.max(0.25, s.speed / 1.25); this.toast(`ball speed ×${s.speed.toFixed(2)}`); break;
        case ']': s.stretch = Math.min(50, s.stretch * 1.5); this.toast(`latency stretch ×${s.stretch.toFixed(1)}`); break;
        case '[': s.stretch = Math.max(0.5, s.stretch / 1.5); this.toast(`latency stretch ×${s.stretch.toFixed(1)}`); break;
        case 'h': case '?': help.hidden = !help.hidden; break;
        case 'd':
          this.debugEl.hidden = !this.debugEl.hidden;
          if (!this.debugEl.hidden) this.showDebug(performance.now());
          break;
        case 'Escape':
          if (help.hidden && !s.focus && this.debugEl.hidden) return;
          s.focus = null;
          help.hidden = true;
          this.debugEl.hidden = true;
          break;
        default: return;
      }
      e.preventDefault();
      e.stopPropagation();
    });
  }
}

// ---- crash guard ------------------------------------------------------------------------------
// While WebGPU draws in a visible tab, each panel writes a heartbeat every second; it is removed
// when the panel goes away, the tab is hidden or the page is left. A heartbeat that stopped
// without that means the tab (or the GPU process) died while drawing: start the next time with
// the 2D view and let the user retry.
const ALIVE_KEY = 'tracepong.gpu.alive';

function readAlive(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(ALIVE_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeAlive(v: Record<string, number>): void {
  try {
    if (Object.keys(v).length) localStorage.setItem(ALIVE_KEY, JSON.stringify(v));
    else localStorage.removeItem(ALIVE_KEY);
  } catch {
    // storage blocked: no guard
  }
}

/** a heartbeat that stopped 5 s to 10 min ago without being removed; clears it either way */
function crashedLastTime(): boolean {
  const v = readAlive();
  const now = Date.now();
  let crashed = false;
  for (const [id, t] of Object.entries(v)) {
    const age = now - t;
    if (age > 5000) {
      if (age < 600000) crashed = true;
      delete v[id];
    }
  }
  writeAlive(v);
  return crashed;
}

function heartbeat(id: string, on: boolean): void {
  const v = readAlive();
  if (on) v[id] = Date.now();
  else delete v[id];
  writeAlive(v);
}

function segDist(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0;
  const l = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l));
  return Math.hypot(px - x0 - t * dx, py - y0 - t * dy);
}

const VIEW_KEY = 'tracepong.view';

function loadViewMode(): ViewMode {
  const m: ViewMode = { endpoints: false, userNames: false, layout: 'radial' };
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Partial<ViewMode>;
    if (typeof v.endpoints === 'boolean') m.endpoints = v.endpoints;
    if (typeof v.userNames === 'boolean') m.userNames = v.userNames;
    if (v.layout === 'flow' || v.layout === 'radial') m.layout = v.layout;
  } catch {
    // storage blocked or garbage: defaults
  }
  return m;
}

function saveViewMode(m: ViewMode): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(m));
  } catch {
    // storage blocked
  }
}
