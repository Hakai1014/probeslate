// Conservative signal heuristics. No hardware/transport fault classification.
export const VERSION = '1.0.1-beta';
export class StabilityAnalyzer {
  constructor(sampleRate) {
    this.rate = sampleRate;
    this.windowSize = Math.max(1, Math.round(sampleRate / 1000));
    this.frames = []; this.samples = 0; this.count = 0; this.energy = 0;
    this.zeros = 0; this.clipped = 0; this.impulses = [];
    this.a = 0; this.b = 0; this.lastImpulse = -Infinity; this.background = 0;
  }
  push(input) {
    for (const x of input) {
      // Isolated, opposite-slope sample excursion against its immediate neighbours.
      const excursion = Math.abs(this.b - (this.a + x) / 2);
      if (excursion > Math.max(0.08, 12 * this.background) &&
          (this.b - this.a) * (x - this.b) < 0 &&
          Math.abs(x - this.a) < excursion * 0.1 &&
          this.samples - this.lastImpulse > this.rate * 0.01) {
        this.impulses.push((this.samples - 1) / this.rate);
        this.lastImpulse = this.samples;
      }
      this.a = this.b; this.b = x;
      this.energy += x * x; this.zeros += Math.abs(x) < 1e-7 ? 1 : 0;
      this.clipped += Math.abs(x) >= 0.999 ? 1 : 0;
      this.samples++; this.count++;
      if (this.count === this.windowSize) this.flush();
    }
  }
  flush() {
    if (!this.count) return;
    const rms = Math.sqrt(this.energy / this.count);
    this.frames.push({rms, zeros: this.zeros / this.count, n: this.count});
    this.background = rms;
    this.count = 0; this.energy = 0; this.zeros = 0;
  }
  finish() {
    this.flush();
    const frames = this.frames, dt = this.windowSize / this.rate;
    const gaps = [], quiet = [];
    const active = frames.filter(f => f.rms >= 0.003).length / Math.max(1, frames.length);
    // Window-based durations are estimates; edge resolution is about 1 ms.
    for (let i = 0; i < frames.length;) {
      if (frames[i].rms >= 0.0001) { i++; continue; }
      const start = i;
      while (i < frames.length && frames[i].rms < 0.0001) i++;
      const length = i - start;
      if (length * dt < 0.004) continue;
      const event = {start: start * dt, duration: length * dt};
      quiet.push(event);
      const flank = Math.ceil(0.02 / dt);
      if (start < flank || i + flank > frames.length || event.duration > 0.25) continue;
      const median = arr => arr.map(f => f.rms).sort((a, b) => a - b)[Math.floor(arr.length / 2)];
      const before = median(frames.slice(start - flank, start));
      const after = median(frames.slice(i, i + flank));
      const zeroFraction = frames.slice(start, i).reduce((sum, f) => sum + f.zeros, 0) / length;
      if (before >= 0.003 && after >= 0.003 && zeroFraction >= 0.98) gaps.push(event);
    }
    const duration = this.samples / this.rate;
    return {version: VERSION, duration, sampleRate: this.rate, activeFraction: active,
      adequate: active >= 0.2, gaps, quiet, impulses: this.impulses,
      clippedFraction: this.clipped / Math.max(1, this.samples),
      longestGap: Math.max(0, ...gaps.map(g => g.duration))};
  }
}
