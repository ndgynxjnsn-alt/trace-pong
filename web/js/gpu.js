// WebGPU renderer: scene -> HDR target -> bloom chain -> tonemapped composite.
import * as S from './shaders.js';

const HDR = 'rgba16float';
export const MAX_SPARKS = 1 << 15;
export const SPARK_FLOATS = 12;
const MAX_HEAT = 64;

const premul = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
const additive = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

export class Renderer {
  static async create(canvas) {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');
    const device = await adapter.requestDevice();
    device.lost.then((info) => console.error('WebGPU device lost:', info.message));
    device.addEventListener?.('uncapturederror', (e) => console.error('WebGPU:', e.error.message));
    return new Renderer(device, canvas);
  }

  constructor(device, canvas) {
    this.device = device;
    this.canvas = canvas;
    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });
    this.bloomOn = true;
    this.size = [0, 0];
    this.sparkCursor = 0;

    const d = device;
    this.globals = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.heatBuf = d.createBuffer({ size: 16 + MAX_HEAT * 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.compParams = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sparkBuf = d.createBuffer({ size: MAX_SPARKS * SPARK_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.sampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.inst = {};  // dynamic instance buffers by name

    const mod = (code) => d.createShaderModule({ code });
    const instLayout = (n) => [{
      arrayStride: n * 16, stepMode: 'instance',
      attributes: [...Array(n)].map((_, i) => ({ shaderLocation: i, offset: i * 16, format: 'float32x4' })),
    }];
    const scenePipe = (code, n, blend) => {
      const module = mod(S.common + code);
      return d.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs', buffers: n ? instLayout(n) : [] },
        fragment: { module, entryPoint: 'fs', targets: [{ format: HDR, blend }] },
        primitive: { topology: 'triangle-list' },
      });
    };

    this.pBg = scenePipe(S.background, 0, undefined);
    this.pEdges = scenePipe(S.edges, 3, premul);
    this.pNodes = scenePipe(S.nodes, 4, premul);
    this.pSprites = scenePipe(S.sprites, 2, premul);
    this.pSparks = scenePipe(S.sparksRender, 0, premul);
    const cmod = mod(S.common + S.sparksCompute);
    this.pSparkStep = d.createComputePipeline({ layout: 'auto', compute: { module: cmod, entryPoint: 'step' } });

    const bmod = mod(S.bloom);
    const bpipe = (entry, blend) => d.createRenderPipeline({
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

    const g = (p) => d.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.globals } }] });
    this.bgEdges = g(this.pEdges);
    this.bgNodes = g(this.pNodes);
    this.bgSprites = g(this.pSprites);
    this.bgBg = d.createBindGroup({
      layout: this.pBg.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.globals } }, { binding: 1, resource: { buffer: this.heatBuf } }],
    });
    const sparkBG = (p) => d.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.globals } }, { binding: 1, resource: { buffer: this.sparkBuf } }],
    });
    this.bgSparks = sparkBG(this.pSparks);
    this.bgSparkStep = sparkBG(this.pSparkStep);
  }

  // (Re)create the HDR target and the bloom mip chain for the canvas pixel size.
  resize(w, h) {
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    if (w === this.size[0] && h === this.size[1]) return;
    this.size = [w, h];
    this.canvas.width = w;
    this.canvas.height = h;
    const d = this.device;
    const tex = (tw, th) => d.createTexture({
      size: [tw, th], format: HDR,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.hdr?.destroy();
    this.mips?.forEach((m) => m.destroy());
    this.hdr = tex(w, h);
    this.mips = [];
    let mw = w, mh = h;
    for (let i = 0; i < 6 && mw > 8 && mh > 8; i++) {
      mw = Math.max(1, mw >> 1);
      mh = Math.max(1, mh >> 1);
      this.mips.push(tex(mw, mh));
    }
    const params = (vals) => {
      const b = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(b, 0, new Float32Array(vals));
      return b;
    };
    const bg = (pipe, view, buf) => d.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: view }, { binding: 1, resource: this.sampler }, { binding: 2, resource: { buffer: buf } }],
    });
    this.downPasses = this.mips.map((m, i) => {
      const src = i === 0 ? this.hdr : this.mips[i - 1];
      return { dst: m.createView(), bg: bg(this.pDown, src.createView(), params([1 / src.width, 1 / src.height, i === 0 ? 1 : 0, 0.9])) };
    });
    this.upPasses = [];
    for (let i = this.mips.length - 2; i >= 0; i--) {
      const src = this.mips[i + 1];
      this.upPasses.push({ dst: this.mips[i].createView(), bg: bg(this.pUp, src.createView(), params([1 / src.width, 1 / src.height, 0, 0])) });
    }
    this.hdrView = this.hdr.createView();
    this.bgComp = d.createBindGroup({
      layout: this.pComp.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.globals } },
        { binding: 1, resource: this.hdrView },
        { binding: 2, resource: this.mips[0].createView() },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: { buffer: this.compParams } },
      ],
    });
  }

  upload(name, data, count, floatsPer) {
    const bytes = Math.max(count * floatsPer * 4, 16);
    let b = this.inst[name];
    if (!b || b.size < bytes) {
      b?.destroy();
      b = this.inst[name] = this.device.createBuffer({
        size: Math.max(1024, 1 << Math.ceil(Math.log2(bytes))),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    if (count) this.device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, count * floatsPer * 4);
    return b;
  }

  // Append freshly spawned sparks into the GPU ring buffer.
  spawnSparks(data, count) {
    const q = this.device.queue;
    let off = 0;
    count = Math.min(count, MAX_SPARKS);
    while (off < count) {
      const n = Math.min(count - off, MAX_SPARKS - this.sparkCursor);
      q.writeBuffer(this.sparkBuf, this.sparkCursor * SPARK_FLOATS * 4,
        data.buffer, data.byteOffset + off * SPARK_FLOATS * 4, n * SPARK_FLOATS * 4);
      this.sparkCursor = (this.sparkCursor + n) % MAX_SPARKS;
      off += n;
    }
  }

  render(f) {
    const d = this.device;
    const [w, h] = this.size;
    const dpr = f.dpr;
    d.queue.writeBuffer(this.globals, 0, new Float32Array([
      f.cam.x, f.cam.y, f.cam.zoom, dpr,
      w / dpr, h / dpr, f.time, f.dt,
      f.dim ?? 0, 0, 0, 0,
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
    if (f.edgeCount) {
      rp.setPipeline(this.pEdges);
      rp.setBindGroup(0, this.bgEdges);
      rp.setVertexBuffer(0, eb);
      rp.draw(6, f.edgeCount);
    }
    if (f.underCount) {
      rp.setPipeline(this.pSprites);
      rp.setBindGroup(0, this.bgSprites);
      rp.setVertexBuffer(0, ub);
      rp.draw(6, f.underCount);
    }
    if (f.nodeCount) {
      rp.setPipeline(this.pNodes);
      rp.setBindGroup(0, this.bgNodes);
      rp.setVertexBuffer(0, nb);
      rp.draw(6, f.nodeCount);
    }
    rp.setPipeline(this.pSparks);
    rp.setBindGroup(0, this.bgSparks);
    rp.draw(6, MAX_SPARKS);
    if (f.overCount) {
      rp.setPipeline(this.pSprites);
      rp.setBindGroup(0, this.bgSprites);
      rp.setVertexBuffer(0, ob);
      rp.draw(6, f.overCount);
    }
    rp.end();

    const pass = (pipe, view, bg, load) => {
      const p = enc.beginRenderPass({
        colorAttachments: [{ view, loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      });
      p.setPipeline(pipe);
      p.setBindGroup(0, bg);
      p.draw(3);
      p.end();
    };
    for (const p of this.downPasses) pass(this.pDown, p.dst, p.bg, false);
    for (const p of this.upPasses) pass(this.pUp, p.dst, p.bg, true);
    pass(this.pComp, this.ctx.getCurrentTexture().createView(), this.bgComp, false);
    d.queue.submit([enc.finish()]);
  }
}
