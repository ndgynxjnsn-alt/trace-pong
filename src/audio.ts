// Space explosions, synthesized with Web Audio (no samples).
// Each boom is filtered noise with a falling cutoff plus a sub-bass thump with a pitch drop, panned
// by where it happens on screen. Every voice goes through a shared long reverb and a compressor,
// so many overlapping booms blend into one rumble instead of clipping. A per-severity voice
// budget keeps busy graphs from turning into white noise.
import type { Severity } from './types';

/** voices per second, burst size */
const BUDGET: Record<Severity, [number, number]> = {
  err: [6, 4],
  warn: [4, 3],
  redirect: [2, 2],
  ok: [5, 3],
};
const SIZE: Record<Severity, number> = { err: 1, warn: 0.55, redirect: 0.25, ok: 0.12 };
const SEVERITIES = Object.keys(BUDGET) as Severity[];

interface Graph {
  ctx: AudioContext;
  dry: GainNode;
  wet: GainNode;
  noise: AudioBuffer;
}

export class Sfx {
  on = false;
  private g: Graph | null = null;
  private readonly tokens: Record<Severity, number> = { err: 4, warn: 3, redirect: 2, ok: 3 };
  private last = 0;

  get ctx(): AudioContext | null {
    return this.g?.ctx ?? null;
  }

  setOn(on: boolean): void {
    this.on = on;
    if (on) void this.init().ctx.resume();
    else void this.g?.ctx.suspend();
  }

  destroy(): void {
    void this.g?.ctx.close();
    this.g = null;
  }

  private init(): Graph {
    if (this.g) return this.g;
    const ctx = new AudioContext();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 14;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.3;
    const master = ctx.createGain();
    master.gain.value = 0.9;
    comp.connect(master).connect(ctx.destination);

    const dry = ctx.createGain();
    dry.gain.value = 0.75;
    dry.connect(comp);
    const verb = ctx.createConvolver();
    verb.buffer = impulse(ctx, 3.8, 2.6);
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    wet.connect(verb).connect(comp);

    // 2 s of white noise, reused by every voice from a random offset
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.g = { ctx, dry, wet, noise };
    return this.g;
  }

  /** pan: -1 (left) .. 1 (right) */
  play(severity: Severity, pan = 0): void {
    const g = this.g;
    if (!this.on || !g || g.ctx.state !== 'running') return;
    const now = g.ctx.currentTime;
    const dt = Math.min(1, now - this.last);
    this.last = now;
    for (const k of SEVERITIES) {
      const [rate, burst] = BUDGET[k];
      this.tokens[k] = Math.min(burst, this.tokens[k] + dt * rate);
    }
    if (this.tokens[severity] < 1) return;
    this.tokens[severity] -= 1;
    this.boom(g, SIZE[severity] * (0.8 + Math.random() * 0.4), Math.max(-1, Math.min(1, pan)), now + Math.random() * 0.02);
  }

  private boom({ ctx, dry, wet, noise }: Graph, size: number, pan: number, t: number): void {
    const dur = 0.25 + size * 1.7;
    const out = ctx.createStereoPanner();
    out.pan.value = pan * 0.8;
    out.connect(dry);
    out.connect(wet);

    // body: noise through a falling low-pass
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = 0.45 + Math.random() * 0.35;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.8 + Math.random() * 2;
    lp.frequency.setValueAtTime(500 + size * 2800 + Math.random() * 600, t);
    lp.frequency.exponentialRampToValueAtTime(50 + Math.random() * 40, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06 + size * 0.5, t + 0.006 + size * 0.02);
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
      c.buffer = noise;
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

/** stereo, exponentially decaying, darkening noise tail: a big empty space */
function impulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
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
