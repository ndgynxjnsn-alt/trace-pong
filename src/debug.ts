// The debug view (key D): which GPU the browser gave us, where the frame time goes, data rates,
// and a plain-language diagnosis.
import type { Renderer } from './gpu';
import type { Scene } from './scene';
import type { Source } from './types';

export interface FrameTimes {
  /** EMA of ms per part of a frame, measured on the CPU */
  update: number;
  build: number;
  encode: number;
  overlay: number;
  /** EMA of ms between frames */
  interval: number;
}

export interface DebugInput {
  /** the renderer in use, null when drawing the 2D fallback */
  gpu: Renderer | null;
  /** the renderer that was created, even if it is not used any more */
  renderer: Renderer | null;
  failure: string | null;
  fps: number;
  times: FrameTimes;
  css: [number, number];
  dpr: number;
  renderScale: number;
  scaleNote: string;
  bloom: boolean;
  scene: Scene;
  source: Source | null;
}

type Cls = '' | 'ok' | 'warn' | 'bad';
type Row = [string, string, Cls?];

const SOFTWARE = /swiftshader|llvmpipe|lavapipe|softpipe|software|basic render/i;

let webglCache: string | null | undefined;

/** The renderer string of a WebGL context: tells which GPU and API (Vulkan, OpenGL, D3D) the browser composites with. */
export function webglRenderer(): string | null {
  if (webglCache !== undefined) return webglCache;
  webglCache = null;
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      webglCache = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    // no WebGL
  }
  return webglCache;
}

export function debugReport(d: DebugInput): { sections: [string, Row[]][]; hints: [string, Cls][] } {
  const sections: [string, Row[]][] = [];
  const hints: [string, Cls][] = [];
  const ua = navigator.userAgent;
  const linux = /Linux/.test(ua) && !/Android/.test(ua);
  const firefox = /Firefox\//.test(ua);
  const ms = (x: number) => `${x.toFixed(2)} ms`;

  // ---- GPU ----
  const r = d.renderer;
  const gpuRows: Row[] = [];
  gpuRows.push(['WebGPU', d.gpu ? 'in use' : r ? 'lost, 2D fallback' : 'unavailable, 2D fallback', d.gpu ? 'ok' : 'bad']);
  if (d.failure && !d.gpu) gpuRows.push(['reason', d.failure, 'bad']);
  let software = false;
  if (r) {
    const info = r.adapter.info;
    const fallbackAdapter = info.isFallbackAdapter === true;
    const name = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ');
    software = fallbackAdapter || SOFTWARE.test(name);
    gpuRows.push(['adapter', name || '(browser does not say)', software ? 'bad' : '']);
    for (const [k, v] of Object.entries(info)) {
      if (['vendor', 'architecture', 'device', 'description'].includes(k)) continue;
      gpuRows.push([k, String(v), k === 'isFallbackAdapter' && v === true ? 'bad' : '']);
    }
    gpuRows.push(['hardware accelerated', software ? 'NO (software adapter)' : 'yes', software ? 'bad' : 'ok']);
    gpuRows.push(['asked for', r.adapter.preference]);
    gpuRows.push(['features', r.adapter.features.join(', ') || 'none']);
    gpuRows.push(['max texture', String(r.adapter.limits.maxTextureDimension2D)]);
  }
  const gl = webglRenderer();
  const glSoftware = !!gl && SOFTWARE.test(gl);
  const glApi = !gl ? 'unknown' : /vulkan/i.test(gl) ? 'Vulkan' : /opengl/i.test(gl) ? 'OpenGL' : /direct3d|d3d1/i.test(gl) ? 'Direct3D' : /metal/i.test(gl) ? 'Metal' : 'unknown';
  gpuRows.push(['WebGL renderer', gl ?? 'WebGL unavailable', glSoftware ? 'bad' : '']);
  gpuRows.push(['compositing API', glApi, glApi === 'Vulkan' || glApi === 'Direct3D' || glApi === 'Metal' ? 'ok' : linux ? 'warn' : '']);
  gpuRows.push(['browser', ua]);
  sections.push(['GPU', gpuRows]);

  // ---- frame ----
  const t = d.times;
  const cpu = t.update + t.build + t.encode + t.overlay;
  const gpuMs = d.gpu?.gpuMs ?? null;
  const backing: [number, number] = [Math.round(d.css[0] * d.dpr * d.renderScale), Math.round(d.css[1] * d.dpr * d.renderScale)];
  sections.push(['Frame', [
    ['fps', `${d.fps.toFixed(0)} (${ms(t.interval)} per frame)`, d.fps >= 50 ? 'ok' : d.fps >= 30 ? 'warn' : 'bad'],
    ['cpu', `${ms(cpu)}  (scene ${ms(t.update)}, pack ${ms(t.build)}, gpu submit ${ms(t.encode)}, labels ${ms(t.overlay)})`, cpu > 12 ? 'warn' : ''],
    ['gpu', gpuMs === null ? (d.gpu ? 'measuring…' : '–') : `${ms(gpuMs)} submit → done`, gpuMs !== null && gpuMs > 14 ? 'warn' : ''],
    ['canvas', `${d.css[0]}×${d.css[1]} css px, dpr ${d.dpr}`],
    ['render', `${backing[0]}×${backing[1]} px, scale ${d.renderScale.toFixed(2)} ${d.scaleNote}`, d.renderScale < 1 ? 'warn' : ''],
    ['bloom', d.bloom ? 'on' : 'off'],
  ]]);

  // ---- scene ----
  const s = d.scene.debugStats();
  sections.push(['Scene', Object.entries(s).map(([k, v]): Row => [k, String(v)])]);
  if (d.gpu) sections[sections.length - 1][1].push(['sparks drawn', String(d.gpu.sparksDrawn)]);

  // ---- data ----
  const st = d.source?.stats?.();
  if (st) sections.push(['Data', Object.entries(st).map(([k, v]): Row => [k, String(v)])]);
  else if (d.source) sections.push(['Data', [['source', 'simulator']]]);

  // ---- diagnosis ----
  if (!d.gpu) {
    hints.push(['WebGPU is not in use; the simple 2D view is drawn instead. Check chrome://gpu (or about:support in Firefox) for "WebGPU".', 'bad']);
  }
  if (software) {
    hints.push(['WebGPU runs on a software (CPU) adapter: no hardware acceleration. In Chrome check chrome://gpu; '
      + (linux ? 'on Linux WebGPU needs Vulkan (chrome://flags/#enable-vulkan, or --enable-features=Vulkan) and a working GPU driver.' : 'update the GPU driver.'), 'bad']);
  }
  if (glSoftware) hints.push(['The browser composites in software (WebGL renderer above). Hardware acceleration is off or the GPU is blocklisted.', 'bad']);
  if (linux && !firefox && d.gpu && glApi === 'OpenGL') {
    hints.push(['Chrome composites with OpenGL, not Vulkan, while WebGPU itself runs on Vulkan. Each WebGPU frame may then take a slower '
      + 'path to the screen. If fps is low while cpu and gpu times are small, try enabling Vulkan (chrome://flags/#enable-vulkan, '
      + 'or start Chrome with --enable-features=Vulkan).', 'warn']);
  }
  if (d.fps > 0 && d.fps < 45) {
    const frame = 1000 / d.fps;
    const known = cpu + (gpuMs ?? 0);
    if (d.gpu && gpuMs !== null && gpuMs > frame * 0.6) {
      hints.push([`GPU-bound: the GPU needs ${ms(gpuMs)} for a ${ms(frame)} frame. Bloom off (B) or a smaller panel helps; the render scale adapts on its own.`, 'warn']);
    } else if (cpu > frame * 0.5) {
      hints.push([`CPU-bound: the panel's JavaScript takes ${ms(cpu)} of a ${ms(frame)} frame. Lower the trace sampling or the traces per second in the panel options.`, 'warn']);
    } else if (known < frame * 0.5) {
      hints.push([`Only ${ms(known)} of a ${ms(frame)} frame is spent in trace-pong (cpu + gpu). The rest is lost outside: `
        + 'presenting the frame in the browser, other tabs or Grafana panels, or a throttled background tab.', 'warn']);
    }
  }
  if (!hints.length) hints.push(['Nothing suspicious.', 'ok']);
  return { sections, hints };
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

export function debugHtml(rep: ReturnType<typeof debugReport>): string {
  const hints = `<h5>Diagnosis</h5><ul>${rep.hints.map(([h, c]) => `<li class="${c}">${esc(h)}</li>`).join('')}</ul>`;
  const secs = rep.sections.map(([title, rows]) =>
    `<h5>${esc(title)}</h5><table>${rows.map(([k, v, c]) => `<tr><td>${esc(k)}</td><td class="${c ?? ''}">${esc(v)}</td></tr>`).join('')}</table>`);
  return hints + secs.join('');
}

export function debugText(rep: ReturnType<typeof debugReport>): string {
  const lines = ['trace-pong debug', '', 'Diagnosis:', ...rep.hints.map(([h]) => `- ${h}`)];
  for (const [title, rows] of rep.sections) {
    lines.push('', `${title}:`);
    for (const [k, v] of rows) lines.push(`  ${k}: ${v}`);
  }
  return lines.join('\n');
}
