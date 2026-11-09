// WebGPU renderer: scene -> HDR target -> bloom chain -> tonemapped composite.
import * as S from './shaders';
import type { Camera } from './types';

const HDR: GPUTextureFormat = 'rgba16float';
export const MAX_SPARKS = 1 << 15;
export const SPARK_FLOATS = 12;
const MAX_HEAT = 64;

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
  static async create(canvas: HTMLCanvasElement): Promise<Renderer> {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');
    const device = await adapter.requestDevice();
    const r = new Renderer(device, canvas);
    device.lost.then((info) => {
      if (info.reason === 'destroyed') return;
      console.error('WebGPU device lost:', info.message);
      r.onLost?.(info.message || 'unknown reason');
    });
    // log validation errors once each instead of every frame
    const seen = new Set<string>();
    device.addEventListener('uncapturederror', (e) => {
      const msg = e.error.message;
      if (seen.size < 20 && !seen.has(msg)) {
        seen.add(msg);
        console.error('WebGPU:', msg);
      }
    });
    return r;
  }

  readonly device: GPUDevice;
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
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
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

  render(f: Frame): void {
    if (!this.hdrView || !this.bgComp) return;
    const d = this.device;
    const [w, h] = this.size;
    const dpr = f.dpr;
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
    rp.setPipeline(this.pSparks);
    rp.setBindGroup(0, this.bgSparks);
    rp.draw(6, MAX_SPARKS);
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
  }
}
