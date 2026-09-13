import {StabilityAnalyzer} from './analyzer.js';
class StabilityProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.analyzer = null; this.remaining = 0; this.tick = 0;
    this.port.onmessage = ({data}) => {
      if (data.type === 'start') {
        this.analyzer = new StabilityAnalyzer(sampleRate);
        this.remaining = Math.round(data.seconds * sampleRate);
        this.tick = 0;
      } else if (data.type === 'cancel') this.analyzer = null;
    };
  }
  process(inputs) {
    if (!this.analyzer) return true;
    const input = inputs[0]?.[0];
    if (!input?.length) return true; // Never fabricate samples for a missing input.
    const n = Math.min(input.length, this.remaining);
    this.analyzer.push(input.subarray(0, n)); this.remaining -= n; this.tick += n;
    if (this.remaining === 0) {
      this.port.postMessage({type: 'result', result: this.analyzer.finish()});
      this.analyzer = null;
    } else if (this.tick >= sampleRate / 5) {
      this.port.postMessage({type: 'progress', elapsed: this.analyzer.samples / sampleRate,
        rms: this.analyzer.background}); this.tick = 0;
    }
    // Default zero output: microphone is never played through the speakers.
    return true;
  }
}
registerProcessor('stability-processor', StabilityProcessor);
