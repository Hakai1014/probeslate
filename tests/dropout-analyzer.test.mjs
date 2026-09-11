import test from 'node:test';
import assert from 'node:assert/strict';
import {StabilityAnalyzer} from '../audio/microphone-dropout-test/analyzer.js';
function tone(rate, seconds = 1, amplitude = 0.08, hz = 233) {
  return Float32Array.from({length: Math.round(rate * seconds)}, (_, i) => amplitude * Math.sin(2 * Math.PI * hz * i / rate));
}
function analyze(samples, rate = 48000, chunk = 128) {
  const a = new StabilityAnalyzer(rate);
  for (let i = 0; i < samples.length; i += chunk) a.push(samples.subarray(i, i + chunk));
  return a.finish();
}
for (const rate of [44100, 48000, 96000]) {
  test(`clean active tone does not report gaps or spikes at ${rate} Hz`, () => {
    const r = analyze(tone(rate), rate); assert.equal(r.gaps.length, 0); assert.equal(r.impulses.length, 0); assert.equal(r.adequate, true);
  });
  test(`known 84 ms digital gap is measured at ${rate} Hz`, () => {
    const signal = tone(rate); signal.fill(0, Math.round(rate * .403), Math.round(rate * .487));
    const r = analyze(signal, rate, 257); assert.equal(r.gaps.length, 1);
    assert.ok(Math.abs(r.gaps[0].duration - .084) < .003); assert.ok(Math.abs(r.gaps[0].start - .403) < .002);
  });
}
test('all silence is inconclusive, with no suspected dropout', () => {
  const r = analyze(new Float32Array(48000)); assert.equal(r.adequate, false); assert.equal(r.gaps.length, 0); assert.equal(r.quiet.length, 1);
});
test('ordinary pause with residual room noise is not a digital dropout', () => {
  const signal = tone(48000);
  for (let i = 18000; i < 24000; i++) signal[i] = .00005 * Math.sin(i * .21);
  const r = analyze(signal); assert.equal(r.gaps.length, 0); assert.equal(r.quiet.length, 1);
});
test('smooth fade to a digital pause does not satisfy active flanks', () => {
  const signal = tone(48000);
  for (let i = 0; i < signal.length; i++) {
    const t = i / 48000;
    if (t >= .3 && t < .4) signal[i] *= ((.4-t)/.1) ** 2;
    if (t >= .4 && t < .5) signal[i] = 0;
    if (t >= .5 && t < .6) signal[i] *= ((t-.5)/.1) ** 2;
  }
  assert.equal(analyze(signal).gaps.length, 0);
});
test('long digital silence and edge silence are not short bounded dropouts', () => {
  const signal = tone(48000, 2); signal.fill(0, 0, 2000); signal.fill(0, 20000, 44000); signal.fill(0, 94000);
  const r = analyze(signal); assert.equal(r.gaps.length, 0); assert.equal(r.quiet.length, 3);
});
test('two separate short gaps remain two events', () => {
  const signal = tone(48000); signal.fill(0, 9600, 10080); signal.fill(0, 24000, 26400);
  assert.equal(analyze(signal).gaps.length, 2);
});
test('single isolated spike is detected, nearby spikes grouped', () => {
  const signal = tone(48000, 1, .004); signal[24000] = .8; signal[24100] = -.8;
  const r = analyze(signal); assert.equal(r.impulses.length, 1); assert.ok(Math.abs(r.impulses[0]-.5)<.001);
});
test('chunk boundaries do not change results', () => {
  const signal = tone(48000, 1, .005); signal.fill(0, 14000, 18000); signal[32000]=.8;
  assert.deepEqual(analyze(signal,48000,128), analyze(signal,48000,997));
});
test('clipping is reported for interpretation, not named a dropout', () => {
  const signal = Float32Array.from(tone(48000, 1, 1.3), v=>Math.max(-1,Math.min(1,v)));
  const r = analyze(signal); assert.ok(r.clippedFraction>.1); assert.equal(r.gaps.length,0);
});
test('fractional final window preserves actual sample duration', () => {
  const r = analyze(tone(44100, .12345),44100); assert.equal(r.duration,Math.round(44100*.12345)/44100);
});
