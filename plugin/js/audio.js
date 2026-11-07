// Space explosions, synthesized with Web Audio (no samples).
// Each boom is filtered noise with a falling cutoff plus a sub-bass thump with a pitch drop, panned
// by where it happens on screen. Every voice goes through a shared long reverb and a compressor,
// so many overlapping booms blend into one rumble instead of clipping. A per-severity voice
// budget keeps busy graphs from turning into white noise.

const BUDGET = {           // voices per second, burst size
  err: [6, 4],
  warn: [4, 3],
  redirect: [2, 2],
  ok: [5, 3],
};
const SIZE = { err: 1, warn: 0.55, redirect: 0.25, ok: 0.12 };

export class Sfx {
  constructor() {
    this.on = false;
    this.ctx = null;
    this.tokens = Object.fromEntries(Object.entries(BUDGET).map(([k, [, burst]]) => [k, burst]));
    this.last = 0;
  }

  setOn(on) {
    this.on = on;
    if (on) {
      this.init();
      this.ctx.resume();
    } else {
      this.ctx?.suspend();
    }
  }

  destroy() {
    this.ctx?.close();
    this.ctx = null;
  }

  init() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 14;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.3;
    const master = ctx.createGain();
    master.gain.value = 0.9;
    comp.connect(master).connect(ctx.destination);

    this.dry = ctx.createGain();
    this.dry.gain.value = 0.75;
    this.dry.connect(comp);
    const verb = ctx.createConvolver();
    verb.buffer = this.impulse(3.8, 2.6);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.55;
    this.wet.connect(verb).connect(comp);

    // 2 s of white noise, reused by every voice from a random offset
    const n = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = n;
  }

  // stereo, exponentially decaying, darkening noise tail: a big empty space
  impulse(seconds, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        lp += (Math.random() * 2 - 1 - lp) * (0.9 - 0.75 * t);   // gets duller over time
        d[i] = lp * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  // severity: err | warn | redirect | ok; pan: -1 (left) .. 1 (right)
  play(severity, pan = 0) {
    if (!this.on || !this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dt = Math.min(1, now - this.last);
    this.last = now;
    for (const [k, [rate, burst]] of Object.entries(BUDGET)) this.tokens[k] = Math.min(burst, this.tokens[k] + dt * rate);
    if (!(severity in BUDGET) || this.tokens[severity] < 1) return;
    this.tokens[severity] -= 1;
    this.boom(SIZE[severity] * (0.8 + Math.random() * 0.4), Math.max(-1, Math.min(1, pan)), now + Math.random() * 0.02);
  }

  boom(size, pan, t) {
    const ctx = this.ctx;
    const dur = 0.25 + size * 1.7;
    const out = ctx.createStereoPanner();
    out.pan.value = pan * 0.8;
    out.connect(this.dry);
    out.connect(this.wet);

    // body: noise through a falling low-pass
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.45 + Math.random() * 0.35;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.8 + Math.random() * 2;
    lp.frequency.setValueAtTime(500 + size * 2800 + Math.random() * 600, t);
    lp.frequency.exponentialRampToValueAtTime(50 + Math.random() * 40, t + dur);
    const g = ctx.createGain();
    const peak = 0.06 + size * 0.5;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.006 + size * 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp).connect(g).connect(out);
    src.start(t, Math.random() * 1.5, dur + 0.05);

    // thump: sine with a pitch drop
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const f0 = (size > 0.5 ? 70 : 140) + Math.random() * 40;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.3, t + 0.15 + size * 0.5);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.04 + size * 0.45, t + 0.008);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.2 + size * 0.7);
    osc.connect(og).connect(out);
    osc.start(t);
    osc.stop(t + 0.25 + size * 0.8);

    // crackle on big ones
    if (size > 0.5) {
      const c = ctx.createBufferSource();
      c.buffer = this.noise;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2500 + Math.random() * 2000;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, t);
      cg.gain.exponentialRampToValueAtTime(0.12 * size, t + 0.004);
      cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      c.connect(hp).connect(cg).connect(out);
      c.start(t, Math.random() * 1.5, 0.15);
    }
    src.onended = () => out.disconnect();
  }
}
