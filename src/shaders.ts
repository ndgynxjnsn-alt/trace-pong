// WGSL for trace-pong. Everything renders into an HDR (rgba16float) target with
// premultiplied-alpha blending; shaders output alpha 0 for purely additive light.

export const common = /* wgsl */`
struct Globals {
  view: vec4f,    // camX, camY, zoom (css px per world unit), dpr
  screen: vec4f,  // width css, height css, time s, dt s
  misc: vec4f,    // focus dim, -, -, -
};
@group(0) @binding(0) var<uniform> G: Globals;

fn toClip(p: vec2f) -> vec4f {
  let s = (p - G.view.xy) * G.view.z;
  return vec4f(s.x / (G.screen.x * 0.5), -s.y / (G.screen.y * 0.5), 0.0, 1.0);
}

fn quad(vi: u32) -> vec2f {
  var q = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
                          vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  return q[vi];
}

fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), u.x),
             mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), u.x), u.y);
}

fn fbm(p0: vec2f) -> f32 {
  var p = p0;
  var a = 0.5;
  var s = 0.0;
  for (var i = 0; i < 5; i++) {
    s += a * noise(p);
    p = mat2x2f(1.6, 1.2, -1.2, 1.6) * p;
    a *= 0.5;
  }
  return s;
}
`;

// ---------------------------------------------------------------------------
// Background: deep-space gradient, drifting nebula, dot grid, heat glow behind busy nodes
// ---------------------------------------------------------------------------
export const background = /* wgsl */`
struct Heat { info: vec4f, pts: array<vec4f, 128> };  // pairs: (x, y, radius, intensity), (r, g, b, _)
@group(0) @binding(1) var<uniform> H: Heat;

struct FsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) vi: u32) -> FsOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: FsOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

@fragment fn fs(in: FsOut) -> @location(0) vec4f {
  let t = G.screen.z;
  let px = in.uv * G.screen.xy;
  let world = (px - G.screen.xy * 0.5) / G.view.z + G.view.xy;
  // parallax: the nebula moves slower than the graph
  let neb = (px - G.screen.xy * 0.5) / max(G.view.z, 0.2) * 0.35 + G.view.xy * 0.35;

  var col = mix(vec3f(0.0025, 0.003, 0.009), vec3f(0.006, 0.004, 0.016), in.uv.y);
  let n1 = fbm(neb * 0.0016 + vec2f(t * 0.012, -t * 0.007));
  let n2 = fbm(neb * 0.0011 - vec2f(t * 0.005, t * 0.009) + 13.7);
  col += vec3f(0.050, 0.010, 0.085) * pow(n1, 3.0) * 2.2;
  col += vec3f(0.000, 0.028, 0.060) * pow(n2, 3.0) * 2.4;

  // heat glow behind nodes that are taking traffic
  let count = i32(H.info.x);
  for (var i = 0; i < count; i++) {
    let a = H.pts[i * 2];
    let c = H.pts[i * 2 + 1];
    let d = world - a.xy;
    let r = a.z;
    col += c.rgb * a.w * exp(-dot(d, d) / (2.0 * r * r));
  }

  // dot grid, fixed to world space, fades when zoomed out
  let cell = 48.0;
  let g = (fract(world / cell + 0.5) - 0.5) * cell * G.view.z;
  let dotv = 1.0 - smoothstep(0.6, 1.4, length(g));
  col += vec3f(0.035, 0.045, 0.075) * dotv * smoothstep(0.25, 0.7, G.view.z);

  return vec4f(col, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Edges: tessellated curve segments; soft line with glow
// ---------------------------------------------------------------------------
export const edges = /* wgsl */`
struct EIn {
  @location(0) p: vec4f,    // x0, y0, x1, y1
  @location(1) s: vec4f,    // arc length at p0, at p1, width (world), flow intensity
  @location(2) col: vec4f,  // rgb, alpha
};
struct EOut {
  @builtin(position) pos: vec4f,
  @location(0) v: f32,       // world distance from the line center
  @location(1) s: f32,
  @location(2) hw: f32,
  @location(3) flow: f32,
  @location(4) col: vec4f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, e: EIn) -> EOut {
  let c = quad(vi);
  let t = c.x * 0.5 + 0.5;
  let d = e.p.zw - e.p.xy;
  let dir = d / max(length(d), 1e-4);
  let nrm = vec2f(-dir.y, dir.x);
  let hw = max(e.s.z * 0.5, 0.6 / G.view.z);
  let ext = hw + 7.0 / G.view.z;
  var o: EOut;
  o.pos = toClip(mix(e.p.xy, e.p.zw, t) + nrm * c.y * ext);
  o.v = c.y * ext;
  o.s = mix(e.s.x, e.s.y, t);
  o.hw = hw;
  o.flow = e.s.w;
  o.col = e.col;
  return o;
}

@fragment fn fs(in: EOut) -> @location(0) vec4f {
  let z = G.view.z;
  let px = abs(in.v) * z;
  let hwpx = in.hw * z;
  let core = 1.0 - smoothstep(hwpx - 0.5, hwpx + 0.8, px);
  let glow = exp(-px * px / (2.0 * (hwpx + 3.0) * (hwpx + 3.0)));
  let col = in.col.rgb * (core * 0.5 + glow * 0.12);
  return vec4f(col * in.col.a, 0.0);
}
`;

// ---------------------------------------------------------------------------
// Group outlines: convex hulls as triangle fans from the centre. Each vertex carries its distance to
// the hull edge of its triangle (0 on the edge), which interpolates to the exact distance inside,
// so the rim stays a few pixels wide at any zoom.
// ---------------------------------------------------------------------------
export const hulls = /* wgsl */`
struct HIn {
  @location(0) a: vec4f,  // x, y, distance to the edge (world), -
  @location(1) c: vec4f,  // rgb, alpha
};
struct HOut {
  @builtin(position) pos: vec4f,
  @location(0) d: f32,
  @location(1) c: vec4f,
};

@vertex fn vs(v: HIn) -> HOut {
  var o: HOut;
  o.pos = toClip(v.a.xy);
  o.d = v.a.z;
  o.c = v.c;
  return o;
}

@fragment fn fs(in: HOut) -> @location(0) vec4f {
  let px = in.d * G.view.z;    // screen pixels to the outline
  let rim = exp(-px * 0.8) * 0.9 + exp(-px * 0.08) * 0.12;
  let fill = 0.035;
  let k = (rim + fill) * in.c.a;
  // mostly additive light, with a touch of occlusion so the group reads as a surface
  return vec4f(in.c.rgb * k * 0.6, fill * in.c.a * 2.0);
}
`;

// ---------------------------------------------------------------------------
// Nodes: Tempo-style ring (green ok / red error arc), dark core, hue glow
// ---------------------------------------------------------------------------
export const nodes = /* wgsl */`
struct NIn {
  @location(0) a: vec4f,  // x, y, radius, pulse
  @location(1) b: vec4f,  // hue rgb, error fraction
  @location(2) c: vec4f,  // -, heat, kind, alpha
  @location(3) d: vec4f,  // hit flash, hover, -, -
};
struct NOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) a: vec4f,
  @location(2) b: vec4f,
  @location(3) c: vec4f,
  @location(4) d: vec4f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, n: NIn) -> NOut {
  let ext = n.a.z * 2.6 + 24.0;
  let local = quad(vi) * ext;
  var o: NOut;
  o.pos = toClip(n.a.xy + local);
  o.local = local;
  o.a = n.a; o.b = n.b; o.c = n.c; o.d = n.d;
  return o;
}

fn angDiff(a: f32, b: f32) -> f32 {
  return abs(atan2(sin(a - b), cos(a - b)));
}

@fragment fn fs(in: NOut) -> @location(0) vec4f {
  let r = in.a.z;
  let pulse = in.a.w;
  let hue = in.b.rgb;
  let err = in.b.a;
  let heat = in.c.y;
  let kind = i32(in.c.z + 0.5);
  let alpha = in.c.w;
  let flash = in.d.x;
  let hover = in.d.y;
  let t = G.screen.z;

  let d = length(in.local);
  let aa = max(fwidth(d), 1e-3);
  let ang = atan2(in.local.x, -in.local.y);          // 0 at top, clockwise
  let a01 = fract(ang / 6.2831853 + 1.0);
  let ringW = 3.2 + hover * 1.2;

  // users: a plain thin ring in their colour around a dark core, nothing else
  if (kind == 3) {
    let w = 1.6 + hover * 1.0;
    let m = 1.0 - smoothstep(w * 0.5 - aa, w * 0.5 + aa, abs(d - r));
    let core = (1.0 - smoothstep(r - aa, r + aa, d)) * 0.85;
    let oc = hue * (1.0 + hover * 0.6) * m + vec3f(0.010, 0.012, 0.022) * core * (1.0 - m);
    return vec4f(oc, m + core * (1.0 - m)) * alpha;
  }

  // dark core with a hue-tinted inner gradient
  let discA = 1.0 - smoothstep(r - aa, r + aa, d);
  let inner = 1.0 - d / r;
  var col = vec3f(0.010, 0.012, 0.022) + hue * (0.02 + 0.06 * heat + 0.12 * pulse) * (0.3 + 0.7 * inner * inner);
  var outc = col * discA * 0.94;
  var outa = discA * 0.94;

  // ring: health arc (Tempo style) -- red fraction from 12 o'clock, rest by kind
  var okc = vec3f(0.22, 0.85, 0.36);
  if (kind == 1) { okc = vec3f(0.20, 0.55, 1.0); }      // database
  if (kind == 2) { okc = vec3f(0.70, 0.40, 1.0); }      // external API
  if (kind == 3) { okc = vec3f(0.85, 0.90, 1.0); }      // user / internet
  var rc = select(okc, vec3f(1.0, 0.13, 0.20), a01 < err);
  var ringMask = 1.0 - smoothstep(ringW * 0.5 - aa, ringW * 0.5 + aa, abs(d - r));
  if (kind >= 2) {
    // dashed ring for things we can't see inside
    let dashes = select(28.0, 40.0, kind == 3);
    ringMask *= smoothstep(0.25, 0.32, abs(fract(a01 * dashes + t * 0.05) - 0.5));
  }
  rc *= 0.8 + pulse * 1.2 + hover * 0.6;
  outc = rc * ringMask + outc * (1.0 - ringMask);
  outa = ringMask + outa * (1.0 - ringMask);

  // second, thin inner ring hinting at load
  let loadR = r - 7.0;
  let loadMask = (1.0 - smoothstep(0.5 - aa, 0.5 + aa, abs(d - loadR))) * step(a01, clamp(heat, 0.0, 1.0));
  outc += hue * loadMask * 0.9;

  // halo: hue glow by heat, red throb when erroring
  let od = max(d - r, 0.0);
  let halo = exp(-od / (r * 0.35)) * smoothstep(r - 2.0, r + 2.0, d);
  outc += hue * halo * (0.03 + heat * 0.10 + pulse * 0.35);
  let alarm = smoothstep(0.02, 0.15, err) * (0.55 + 0.45 * sin(t * 5.0));
  outc += vec3f(1.0, 0.08, 0.12) * halo * alarm * 0.9;

  return vec4f(outc, outa) * alpha;
}
`;

// ---------------------------------------------------------------------------
// Sprites: balls (with HDR hot core), rings (shockwaves), soft glows
// ---------------------------------------------------------------------------
export const sprites = /* wgsl */`
struct SIn {
  @location(0) a: vec4f,  // x, y, size, shape
  @location(1) c: vec4f,  // rgb, alpha
};
struct SOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,   // in units of size
  @location(1) c: vec4f,
  @location(2) shape: f32,
  @location(3) sizepx: f32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, s: SIn) -> SOut {
  let shape = s.a.w;
  let size = max(s.a.z, 1.1 / G.view.z);
  var ext = 3.2;
  if (shape > 0.5 && shape < 1.5) { ext = 1.0 + 4.0 / (size * G.view.z) + 0.25; }
  let c = quad(vi) * ext;
  var o: SOut;
  o.pos = toClip(s.a.xy + c * size);
  o.local = c;
  o.c = s.c;
  o.shape = shape;
  o.sizepx = size * G.view.z;
  return o;
}

@fragment fn fs(in: SOut) -> @location(0) vec4f {
  let d = length(in.local);
  var v = vec3f(0.0);
  if (in.shape < 0.5) {
    // ball: solid body, white-hot center, wide halo
    let core = 1.0 - smoothstep(0.8, 1.0 + 1.0 / in.sizepx, d);
    let hot = exp(-d * d * 5.0);
    let halo = exp(-d * d * 0.55);
    v = in.c.rgb * (core * 1.4 + halo * 0.45) + vec3f(1.0) * hot * core * 0.9;
  } else if (in.shape < 1.5) {
    // ring / shockwave
    let w = 0.05 + 1.2 / in.sizepx;
    let x = (d - 1.0) / w;
    v = in.c.rgb * exp(-x * x) * 1.6;
  } else {
    // soft glow
    v = in.c.rgb * exp(-d * d * 1.6);
  }
  return vec4f(v * in.c.a, 0.0);
}
`;

// ---------------------------------------------------------------------------
// Sparks: GPU particle system (compute integrate + streak rendering)
// ---------------------------------------------------------------------------
const particleStruct = /* wgsl */`
struct P {
  pos: vec2f, vel: vec2f,
  life: f32, maxLife: f32, size: f32, drag: f32,
  col: vec4f,
};
`;

export const sparksCompute = particleStruct + /* wgsl */`
@group(0) @binding(1) var<storage, read_write> ps: array<P>;

@compute @workgroup_size(64) fn step(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&ps)) { return; }
  var p = ps[id.x];
  if (p.life <= 0.0) { return; }
  let dt = G.screen.w;
  p.life -= dt;
  p.vel *= pow(p.drag, dt);
  p.pos += p.vel * dt;
  ps[id.x] = p;
}
`;

export const sparksRender = particleStruct + /* wgsl */`
@group(0) @binding(1) var<storage, read> ps: array<P>;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) col: vec4f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  let p = ps[ii];
  var o: Out;
  if (p.life <= 0.0) {
    o.pos = vec4f(0.0, 0.0, 2.0, 1.0);   // outside the depth range: culled
    return o;
  }
  let c = quad(vi);
  let sp = length(p.vel);
  let dir = select(vec2f(1.0, 0.0), p.vel / sp, sp > 1e-3);
  let nrm = vec2f(-dir.y, dir.x);
  let k = clamp(p.life / p.maxLife, 0.0, 1.0);
  let w = max(p.size * (0.35 + 0.65 * k), 0.9 / G.view.z);
  let len = w + sp * 0.05;
  o.pos = toClip(p.pos + dir * c.x * len + nrm * c.y * w);
  o.uv = vec2f(c.x, c.y);
  o.col = vec4f(p.col.rgb * (0.4 + 1.6 * k * k), p.col.a * k);
  return o;
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  let d = dot(in.uv, in.uv);
  let a = exp(-d * 3.0);
  return vec4f(in.col.rgb * a * in.col.a, 0.0);
}
`;

// ---------------------------------------------------------------------------
// Post: dual-filter bloom + ACES composite with vignette, CA and grain
// ---------------------------------------------------------------------------
const fullscreen = /* wgsl */`
struct FsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> FsOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: FsOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
`;

export const bloom = fullscreen + /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> P: vec4f;  // texel x, texel y, prefilter?, threshold

fn tap(uv: vec2f) -> vec3f { return textureSampleLevel(src, samp, uv, 0.0).rgb; }

@fragment fn down(in: FsOut) -> @location(0) vec4f {
  let o = P.xy;
  var c = tap(in.uv) * 4.0 + tap(in.uv - o) + tap(in.uv + o)
        + tap(in.uv + vec2f(o.x, -o.y)) + tap(in.uv + vec2f(-o.x, o.y));
  c /= 8.0;
  if (P.z > 0.5) {
    let br = max(c.r, max(c.g, c.b));
    let knee = P.w * 0.6;
    var soft = clamp(br - P.w + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    let contrib = max(soft, br - P.w) / max(br, 1e-4);
    c = min(c * contrib, vec3f(40.0));
  }
  return vec4f(c, 1.0);
}

@fragment fn up(in: FsOut) -> @location(0) vec4f {
  let o = P.xy;
  var c = tap(in.uv + vec2f(-o.x * 2.0, 0.0)) + tap(in.uv + vec2f(o.x * 2.0, 0.0))
        + tap(in.uv + vec2f(0.0, -o.y * 2.0)) + tap(in.uv + vec2f(0.0, o.y * 2.0));
  c += (tap(in.uv + vec2f(-o.x, -o.y)) + tap(in.uv + vec2f(o.x, -o.y))
      + tap(in.uv + vec2f(-o.x, o.y)) + tap(in.uv + vec2f(o.x, o.y))) * 2.0;
  return vec4f(c / 12.0, 1.0);
}
`;

export const composite = fullscreen + /* wgsl */`
struct Globals {
  view: vec4f, screen: vec4f, misc: vec4f,
};
@group(0) @binding(0) var<uniform> G: Globals;
@group(0) @binding(1) var hdr: texture_2d<f32>;
@group(0) @binding(2) var blm: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<uniform> P: vec4f;   // bloom strength, exposure, vignette, grain

fn aces(x: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }

@fragment fn fs(in: FsOut) -> @location(0) vec4f {
  let uv = in.uv;
  let off = (uv - 0.5) * 0.0025;
  var c = vec3f(textureSampleLevel(hdr, samp, uv + off, 0.0).r,
                textureSampleLevel(hdr, samp, uv, 0.0).g,
                textureSampleLevel(hdr, samp, uv - off, 0.0).b);
  c += textureSampleLevel(blm, samp, uv, 0.0).rgb * P.x;
  c = aces(c * P.y);
  let v = uv - 0.5;
  c *= 1.0 - dot(v, v) * P.z;
  c = pow(c, vec3f(1.0 / 2.2));
  c += (hash(uv * G.screen.xy + fract(G.screen.z) * 100.0) - 0.5) * P.w;
  return vec4f(c, 1.0);
}
`;
