// WebGPU renderer: scene -> HDR target -> bloom chain -> tonemapped composite.
import * as S from './shaders';
import type { Camera } from './types';

const HDR: GPUTextureFormat = 'rgba16float';
export const MAX_SPARKS = 1 << 15;
export const SPARK_FLOATS = 12;
const MAX_HEAT = 64;
const MAX_PIXELS = 3840 * 2160;

const premul: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
const additive: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

/** Everything one frame draws; instance data is packed by the scene. */
export interface Frame {
  cam: Camera;
  dpr: number;
  time: number;
  dt: number;
  dim: number;
  nodes: Float32Array<ArrayBuffer>;
  nodeCount: number;
  edges: Float32Array<ArrayBuffer>;
  edgeCount: number;
  under: Float32Array<ArrayBuffer>;
  underCount: number;
  over: Float32Array<ArrayBuffer>;
  overCount: number;
  heat: Float32Array<ArrayBuffer>;
  heatCount: number;
  /** group outlines: triangle list, 8 floats per vertex */
  hulls: Float32Array<ArrayBuffer>;
  hullCount: number;
  sparks: Float32Array<ArrayBuffer>;
  sparkCount: number;
}

interface Pass {
  dst: GPUTextureView;
  bg: GPUBindGroup;
}

export class Renderer {
  /**
   * Start WebGPU, or throw with a readable reason. Asks for the high-performance GPU first, then
   * the default and the low-power one. Each candidate must create every pipeline without a
   * validation or internal error (some drivers, e.g. Firefox on integrated GPUs, fail here),
   * otherwise the next one is tried.
   */
  static async create(canvas: HTMLCanvasElement): Promise<Renderer> {
    const gpu = navigator.gpu;
    if (!gpu) throw new Error('WebGPU is not available in this browser.');
    const problems: string[] = [];
    // Firefox hands out a new adapter object per request: recognise the same GPU by its info
    const tried = new Set<string>();
    for (const pref of ['high-performance', undefined, 'low-power'] as (GPUPowerPreference | undefined)[]) {
      const label = pref ?? 'default';
      let adapter: GPUAdapter | null = null;
      try {
        adapter = await gpu.requestAdapter(pref ? { powerPreference: pref } : undefined);
      } catch (e) {
        problems.push(`${label}: ${errMsg(e)}`);
        continue;
      }
      if (!adapter) {
        problems.push(`${label}: no adapter`);
        continue;
      }
      const report = describeAdapter(adapter, label);
      const key = JSON.stringify(report.info) + report.features.join();
      if (tried.has(key)) continue;
      tried.add(key);
      let device: GPUDevice | null = null;
      try {
        device = await adapter.requestDevice();
        device.pushErrorScope('out-of-memory');
        device.pushErrorScope('internal');
        device.pushErrorScope('validation');
        const r = new Renderer(device, canvas);
        r.adapter = report;
        r.resize(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight));
        const errors = [await device.popErrorScope(), await device.popErrorScope(), await device.popErrorScope()].filter(Boolean);
        if (errors.length) throw new Error(errors.map((x) => x?.message).join(' / '));
        r.watch();
        return r;
      } catch (e) {
        problems.push(`${label}: ${errMsg(e)}`);
        device?.destroy();
      }
    }
    throw new Error(`WebGPU could not start (${problems.join('; ')})`);
  }

  /** report device loss, and give up on a device that keeps erroring (log each message once) */
  private watch(): void {
    const device = this.device;
    device.lost.then((info) => {
      if (info.reason === 'destroyed') return;
      console.error('WebGPU device lost:', info.message);
      this.onLost?.(info.message || 'unknown reason');
    });
    const seen = new Set<string>();
    let count = 0, since = performance.now();
    device.addEventListener('uncapturederror', (e) => {
      const msg = e.error.message;
      if (seen.size < 20 && !seen.has(msg)) {
        seen.add(msg);
        console.error('WebGPU:', msg);
      }
      const now = performance.now();
      if (now - since > 5000) {
        count = 0;
        since = now;
      }
      if (++count === 30) this.onLost?.(`repeated WebGPU errors: ${msg}`);
    });
  }


  readonly device: GPUDevice;
  /** what the browser gave us, for the debug view */
  adapter: AdapterReport = { preference: '', info: {}, features: [], limits: {} };
  /** ms from submitting a frame until the GPU finished it, null until measured */
  gpuMs: number | null = null;
  /** submit times of frames the GPU has not finished yet */
  private inFlight: number[] = [];
  /** frames skipped because the GPU was still busy with earlier ones */
  skipped = 0;
  private dtCarry = 0;
  /** canvas resolution actually used relative to the requested one (texture and memory limits) */
  clampScale = 1;
  /** spark spawns as [scene clock, count], to draw only the part of the ring that can be alive */
  private sparkLog: [number, number][] = [];
  private sparkClock = 0;
  /** sparks drawn in the last frame */
  sparksDrawn = 0;
  bloomOn = true;
  /** called when the GPU device is lost (driver reset, GPU process crash, ...) */
  onLost: ((message: string) => void) | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: GPUCanvasContext;
  private readonly format: GPUTextureFormat;
  private size: [number, number] = [0, 0];
  private sparkCursor = 0;

  private readonly globals: GPUBuffer;
  private readonly heatBuf: GPUBuffer;
  private readonly compParams: GPUBuffer;
  private readonly sparkBuf: GPUBuffer;
  private readonly sampler: GPUSampler;
  private readonly inst = new Map<string, GPUBuffer>();   // dynamic instance buffers by name

  private readonly pBg: GPURenderPipeline;
  private readonly pEdges: GPURenderPipeline;
  private readonly pHulls: GPURenderPipeline;
  private readonly pNodes: GPURenderPipeline;
  private readonly pSprites: GPURenderPipeline;
  private readonly pSparks: GPURenderPipeline;
  private readonly pSparkStep: GPUComputePipeline;
  private readonly pDown: GPURenderPipeline;
  private readonly pUp: GPURenderPipeline;
  private readonly pComp: GPURenderPipeline;
  private readonly bgEdges: GPUBindGroup;
  private readonly bgHulls: GPUBindGroup;
  private readonly bgNodes: GPUBindGroup;
  private readonly bgSprites: GPUBindGroup;
  private readonly bgBg: GPUBindGroup;
  private readonly bgSparks: GPUBindGroup;
  private readonly bgSparkStep: GPUBindGroup;

  // size-dependent, created by resize()
  private hdr?: GPUTexture;
  private hdrView?: GPUTextureView;
  private mips: GPUTexture[] = [];
  private paramBufs: GPUBuffer[] = [];
  private downPasses: Pass[] = [];
  private upPasses: Pass[] = [];
  private bgComp?: GPUBindGroup;

  constructor(device: GPUDevice, canvas: HTMLCanvasElement) {
    this.device = device;
    this.canvas = canvas;
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('Could not get a WebGPU canvas context.');
    this.ctx = ctx;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format: this.format, alphaMode: 'opaque' });

    const d = device;
    this.globals = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.heatBuf = d.createBuffer({ size: 16 + MAX_HEAT * 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.compParams = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sparkBuf = d.createBuffer({ size: MAX_SPARKS * SPARK_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.sampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    const mod = (code: string) => d.createShaderModule({ code });
    const instLayout = (n: number): GPUVertexBufferLayout[] => [{
      arrayStride: n * 16,
      stepMode: 'instance',
      attributes: Array.from({ length: n }, (_, i): GPUVertexAttribute => ({ shaderLocation: i, offset: i * 16, format: 'float32x4' })),
    }];
    const scenePipe = (code: string, n: number, blend?: GPUBlendState) => {
      const module = mod(S.common + code);
      return d.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs', buffers: n ? instLayout(n) : [] },
        fragment: { module, entryPoint: 'fs', targets: [{ format: HDR, blend }] },
        primitive: { topology: 'triangle-list' },
      });
    };

    this.pBg = scenePipe(S.background, 0);
    this.pEdges = scenePipe(S.edges, 3, premul);
    const hmod = mod(S.common + S.hulls);
    this.pHulls = d.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: hmod, entryPoint: 'vs',
        buffers: [{
          arrayStride: 32, stepMode: 'vertex',
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }, { shaderLocation: 1, offset: 16, format: 'float32x4' }],
        }],
      },
      fragment: { module: hmod, entryPoint: 'fs', targets: [{ format: HDR, blend: premul }] },
      primitive: { topology: 'triangle-list' },
    });
    this.pNodes = scenePipe(S.nodes, 4, premul);
    this.pSprites = scenePipe(S.sprites, 2, premul);
    this.pSparks = scenePipe(S.sparksRender, 0, premul);
    const cmod = mod(S.common + S.sparksCompute);
    this.pSparkStep = d.createComputePipeline({ layout: 'auto', compute: { module: cmod, entryPoint: 'step' } });

    const bmod = mod(S.bloom);
    const bpipe = (entry: string, blend?: GPUBlendState) => d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: bmod, entryPoint: 'vs' },
      fragment: { module: bmod, entryPoint: entry, targets: [{ format: HDR, blend }] },
      primitive: { topology: 'triangle-list' },
    });
    this.pDown = bpipe('down');
    this.pUp = bpipe('up', additive);
    const compMod = mod(S.composite);
    this.pComp = d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: compMod, entryPoint: 'vs' },
      fragment: { module: compMod, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });

    const g = (p: GPURenderPipeline) => d.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.globals } }],
    });
    this.bgEdges = g(this.pEdges);
    this.bgHulls = g(this.pHulls);
    this.bgNodes = g(this.pNodes);
    this.bgSprites = g(this.pSprites);
    this.bgBg = d.createBindGroup({
      layout: this.pBg.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.globals } }, { binding: 1, resource: { buffer: this.heatBuf } }],
    });
    const sparkBG = (p: GPURenderPipeline | GPUComputePipeline) => d.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.globals } }, { binding: 1, resource: { buffer: this.sparkBuf } }],
    });
    this.bgSparks = sparkBG(this.pSparks);
    this.bgSparkStep = sparkBG(this.pSparkStep);
  }

  /** (Re)create the HDR target and the bloom mip chain for the canvas pixel size. */
  resize(width: number, height: number): void {
    // stay inside the device's texture size and about 4K worth of pixels: the HDR target and its
    // bloom chain cost ~10 bytes per pixel, which adds up on integrated GPUs
    const maxDim = this.device.limits.maxTextureDimension2D;
    const k = Math.min(1, maxDim / Math.max(1, width), maxDim / Math.max(1, height), Math.sqrt(MAX_PIXELS / Math.max(1, width * height)));
    this.clampScale = k;
    const w = Math.max(1, Math.floor(width * k));
    const h = Math.max(1, Math.floor(height * k));
    if (w === this.size[0] && h === this.size[1]) return;
    this.size = [w, h];
    this.canvas.width = w;
    this.canvas.height = h;
    const d = this.device;
    const tex = (tw: number, th: number) => d.createTexture({
      size: [tw, th],
      format: HDR,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.hdr?.destroy();
    this.mips.forEach((m) => m.destroy());
    this.paramBufs.forEach((b) => b.destroy());
    this.paramBufs = [];
    const hdr = tex(w, h);
    this.hdr = hdr;
    this.mips = [];
    let mw = w, mh = h;
    for (let i = 0; i < 6 && mw > 8 && mh > 8; i++) {
      mw = Math.max(1, mw >> 1);
      mh = Math.max(1, mh >> 1);
      this.mips.push(tex(mw, mh));
    }
    const params = (vals: number[]) => {
      const b = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(b, 0, new Float32Array(vals));
      this.paramBufs.push(b);
      return b;
    };
    const bg = (pipe: GPURenderPipeline, view: GPUTextureView, buf: GPUBuffer) => d.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: view }, { binding: 1, resource: this.sampler }, { binding: 2, resource: { buffer: buf } }],
    });
    this.downPasses = this.mips.map((m, i) => {
      const src = i === 0 ? hdr : this.mips[i - 1];
      return { dst: m.createView(), bg: bg(this.pDown, src.createView(), params([1 / src.width, 1 / src.height, i === 0 ? 1 : 0, 0.9])) };
    });
    this.upPasses = [];
    for (let i = this.mips.length - 2; i >= 0; i--) {
      const src = this.mips[i + 1];
      this.upPasses.push({ dst: this.mips[i].createView(), bg: bg(this.pUp, src.createView(), params([1 / src.width, 1 / src.height, 0, 0])) });
    }
    this.hdrView = hdr.createView();
    this.bgComp = d.createBindGroup({
      layout: this.pComp.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.globals } },
        { binding: 1, resource: this.hdrView },
        { binding: 2, resource: (this.mips[0] ?? hdr).createView() },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: { buffer: this.compParams } },
      ],
    });
  }

  private upload(name: string, data: Float32Array<ArrayBuffer>, count: number, floatsPer: number): GPUBuffer {
    const bytes = Math.max(count * floatsPer * 4, 16);
    let b = this.inst.get(name);
    if (!b || b.size < bytes) {
      b?.destroy();
      b = this.device.createBuffer({
        size: Math.max(1024, 1 << Math.ceil(Math.log2(bytes))),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.inst.set(name, b);
    }
    // offsets and sizes are in elements for typed arrays
    if (count) this.device.queue.writeBuffer(b, 0, data, 0, count * floatsPer);
    return b;
  }

  /** Append freshly spawned sparks into the GPU ring buffer. */
  private spawnSparks(data: Float32Array<ArrayBuffer>, total: number): void {
    const q = this.device.queue;
    const count = Math.min(total, MAX_SPARKS);
    let off = 0;
    while (off < count) {
      const n = Math.min(count - off, MAX_SPARKS - this.sparkCursor);
      q.writeBuffer(this.sparkBuf, this.sparkCursor * SPARK_FLOATS * 4, data, off * SPARK_FLOATS, n * SPARK_FLOATS);
      this.sparkCursor = (this.sparkCursor + n) % MAX_SPARKS;
      off += n;
    }
  }

  /**
   * Draw a frame. Returns false when it was skipped: never more than two frames queued on the GPU,
   * otherwise a slow GPU makes the browser buffer frame after frame (and their uploads) until
   * memory runs out.
   */
  render(f: Frame): boolean {
    if (!this.hdrView || !this.bgComp) return false;
    const now = performance.now();
    // a frame the GPU has not reported in 1 s is not waited for any longer
    this.inFlight = this.inFlight.filter((t) => now - t < 1000);
    if (this.inFlight.length >= 2) {
      this.skipped++;
      this.dtCarry += f.dt;
      return false;
    }
    f = { ...f, dt: f.dt + this.dtCarry };
    this.dtCarry = 0;
    const d = this.device;
    const [w, h] = this.size;
    const dpr = f.dpr * this.clampScale;
    d.queue.writeBuffer(this.globals, 0, new Float32Array([
      f.cam.x, f.cam.y, f.cam.zoom, dpr,
      w / dpr, h / dpr, f.time, f.dt,
      f.dim, 0, 0, 0,
      0, 0, 0, 0,
    ]));
    const heat = new Float32Array(4 + MAX_HEAT * 8);
    const hc = Math.min(f.heatCount, MAX_HEAT);
    heat[0] = hc;
    heat.set(f.heat.subarray(0, hc * 8), 4);
    d.queue.writeBuffer(this.heatBuf, 0, heat);
    d.queue.writeBuffer(this.compParams, 0, new Float32Array([this.bloomOn ? 0.7 : 0, 1.1, 0.9, 0.018]));
    if (f.sparkCount) this.spawnSparks(f.sparks, f.sparkCount);
    // sparks live ~1 s of scene time: only the slots written in the last 2 s can be alive
    this.sparkClock += f.dt;
    if (f.sparkCount) this.sparkLog.push([this.sparkClock, Math.min(f.sparkCount, MAX_SPARKS)]);
    while (this.sparkLog.length && this.sparkClock - this.sparkLog[0][0] > 2) this.sparkLog.shift();
    let live = 0;
    for (const [, n] of this.sparkLog) live += n;
    live = Math.min(MAX_SPARKS, live);
    this.sparksDrawn = live;

    const eb = this.upload('edges', f.edges, f.edgeCount, 12);
    const nb = this.upload('nodes', f.nodes, f.nodeCount, 16);
    const ub = this.upload('under', f.under, f.underCount, 8);
    const ob = this.upload('over', f.over, f.overCount, 8);
    const hb = this.upload('hulls', f.hulls, f.hullCount, 8);

    const enc = d.createCommandEncoder();
    const cp = enc.beginComputePass();
    cp.setPipeline(this.pSparkStep);
    cp.setBindGroup(0, this.bgSparkStep);
    cp.dispatchWorkgroups(Math.ceil(MAX_SPARKS / 64));
    cp.end();

    const rp = enc.beginRenderPass({
      colorAttachments: [{ view: this.hdrView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    rp.setPipeline(this.pBg);
    rp.setBindGroup(0, this.bgBg);
    rp.draw(3);
    const instanced = (pipe: GPURenderPipeline, group: GPUBindGroup, buf: GPUBuffer, count: number) => {
      if (!count) return;
      rp.setPipeline(pipe);
      rp.setBindGroup(0, group);
      rp.setVertexBuffer(0, buf);
      rp.draw(6, count);
    };
    if (f.hullCount) {
      rp.setPipeline(this.pHulls);
      rp.setBindGroup(0, this.bgHulls);
      rp.setVertexBuffer(0, hb);
      rp.draw(f.hullCount);
    }
    instanced(this.pEdges, this.bgEdges, eb, f.edgeCount);
    instanced(this.pSprites, this.bgSprites, ub, f.underCount);
    instanced(this.pNodes, this.bgNodes, nb, f.nodeCount);
    if (live) {
      rp.setPipeline(this.pSparks);
      rp.setBindGroup(0, this.bgSparks);
      // the newest `live` slots of the ring, which may wrap around its end
      const start = (this.sparkCursor - live + MAX_SPARKS) % MAX_SPARKS;
      const first = Math.min(live, MAX_SPARKS - start);
      rp.draw(6, first, 0, start);
      if (live > first) rp.draw(6, live - first, 0, 0);
    }
    instanced(this.pSprites, this.bgSprites, ob, f.overCount);
    rp.end();

    const pass = (pipe: GPURenderPipeline, view: GPUTextureView, group: GPUBindGroup, load: boolean) => {
      const p = enc.beginRenderPass({
        colorAttachments: [{ view, loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      });
      p.setPipeline(pipe);
      p.setBindGroup(0, group);
      p.draw(3);
      p.end();
    };
    for (const p of this.downPasses) pass(this.pDown, p.dst, p.bg, false);
    for (const p of this.upPasses) pass(this.pUp, p.dst, p.bg, true);
    pass(this.pComp, this.ctx.getCurrentTexture().createView(), this.bgComp, false);
    d.queue.submit([enc.finish()]);
    const t0 = performance.now();
    this.inFlight.push(t0);
    const done = () => {
      const i = this.inFlight.indexOf(t0);
      if (i >= 0) this.inFlight.splice(i, 1);
    };
    d.queue.onSubmittedWorkDone().then(() => {
      const ms = performance.now() - t0;
      this.gpuMs = this.gpuMs === null ? ms : this.gpuMs * 0.9 + ms * 0.1;
      done();
    }, done);
    return true;
  }
}

export interface AdapterReport {
  /** the power preference that produced this adapter */
  preference: string;
  /** GPUAdapterInfo: vendor, architecture, device, description, isFallbackAdapter, ... */
  info: Record<string, string | number | boolean>;
  features: string[];
  limits: Record<string, number>;
}

function describeAdapter(adapter: GPUAdapter, preference: string): AdapterReport {
  const info: Record<string, string | number | boolean> = {};
  const ai = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
  if (ai) {
    // GPUAdapterInfo attributes live on the prototype: for..in sees them
    for (const k in ai) {
      const v = (ai as unknown as Record<string, unknown>)[k];
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') info[k] = v;
    }
  }
  const legacy = (adapter as unknown as { isFallbackAdapter?: boolean }).isFallbackAdapter;
  if (typeof legacy === 'boolean' && !('isFallbackAdapter' in info)) info.isFallbackAdapter = legacy;
  const limits: Record<string, number> = {};
  for (const k of ['maxTextureDimension2D', 'maxBufferSize', 'maxComputeWorkgroupsPerDimension'] as const) {
    limits[k] = adapter.limits[k];
  }
  return { preference, info, features: [...adapter.features].sort(), limits };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
