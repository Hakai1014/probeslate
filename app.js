'use strict';

const CONFIG = {
  fftSize: 32768,
  measurementMs: 8000,
  initialWarmupMs: 3000,
  comparisonSettleMs: 15000,
  repeatGapMs: 3000,
  overlapFraction: 0.50,
  maxAnalysisHz: 600,
  analyserMinDb: -100,
  analyserMaxDb: -10,

  // Engineering heuristics for V1.25. These are not validated standards.
  supportMedianDb: 6,
  supportP25Db: 4,
  strongMedianDb: 10,
  strongP25Db: 7,

  backgroundInnerHz: 10,
  backgroundOuterHz: 25,
  exclusionHz: 5,
  lowInputRmsDbfs: -75,

  // Before/After comparison remains provisional until repeatability testing.
  comparisonDeltaDb: 4,
  sessionIdleMs: 120000,
  maxGapMultiplier: 2.5,
  devRuns: 5,
};

const FAMILIES = {
  '50 Hz': [50, 100, 150, 200, 250],
  '60 Hz': [60, 120, 180, 240, 360],
};

const NON_DISCRIMINATING = [300];
const ALL_EXPECTED = [...new Set([
  ...FAMILIES['50 Hz'],
  ...FAMILIES['60 Hz'],
  ...NON_DISCRIMINATING,
])].sort((a, b) => a - b);
const ALL_TARGETS = [...new Set([
  ...FAMILIES['50 Hz'],
  ...FAMILIES['60 Hz'],
])].sort((a, b) => a - b);

const els = {
  micSelect: document.querySelector('#micSelect'),
  startButton: document.querySelector('#startButton'),
  retestButton: document.querySelector('#retestButton'),
  testCard: document.querySelector('#testCard'),
  resultCard: document.querySelector('#resultCard'),
  testStatus: document.querySelector('#testStatus'),
  countdown: document.querySelector('#countdown'),
  meterFill: document.querySelector('#meterFill'),
  meterLabel: document.querySelector('#meterLabel'),
  processingWarning: document.querySelector('#processingWarning'),
  deviceWarning: document.querySelector('#deviceWarning'),
  interruptionWarning: document.querySelector('#interruptionWarning'),
  cancelActiveButton: document.querySelector('#cancelActiveButton'),

  resultTitle: document.querySelector('#resultTitle'),
  resultSummary: document.querySelector('#resultSummary'),
  patternValue: document.querySelector('#patternValue'),
  strengthValue: document.querySelector('#strengthValue'),
  confidenceValue: document.querySelector('#confidenceValue'),
  validityNotice: document.querySelector('#validityNotice'),
  micActiveNotice: document.querySelector('#micActiveNotice'),
  sampleRateValue: document.querySelector('#sampleRateValue'),
  rmsValue: document.querySelector('#rmsValue'),
  snapshotValue: document.querySelector('#snapshotValue'),
  windowValue: document.querySelector('#windowValue'),
  hopValue: document.querySelector('#hopValue'),
  harmonicTableWrap: document.querySelector('#harmonicTableWrap'),

  comparisonOffer: document.querySelector('#comparisonOffer'),
  comparisonInstructions: document.querySelector('#comparisonInstructions'),
  prepareComparisonButton: document.querySelector('#prepareComparisonButton'),
  endSessionButton: document.querySelector('#endSessionButton'),
  runComparisonButton: document.querySelector('#runComparisonButton'),
  cancelComparisonButton: document.querySelector('#cancelComparisonButton'),

  comparisonCard: document.querySelector('#comparisonCard'),
  comparisonTitle: document.querySelector('#comparisonTitle'),
  comparisonSummary: document.querySelector('#comparisonSummary'),
  beforePatternValue: document.querySelector('#beforePatternValue'),
  beforeConfidenceValue: document.querySelector('#beforeConfidenceValue'),
  afterPatternValue: document.querySelector('#afterPatternValue'),
  afterConfidenceValue: document.querySelector('#afterConfidenceValue'),
  comparisonEvidence: document.querySelector('#comparisonEvidence'),
  comparisonTableWrap: document.querySelector('#comparisonTableWrap'),
  newSessionButton: document.querySelector('#newSessionButton'),

  devCard: document.querySelector('#devCard'),
  devRunButton: document.querySelector('#devRunButton'),
  devCancelButton: document.querySelector('#devCancelButton'),
  devStatus: document.querySelector('#devStatus'),
  devOutput: document.querySelector('#devOutput'),
};

let session = null;
let baselineMeasurement = null;
let appState = 'IDLE';
let activeReject = null;
let entryBusy = false;

class MeasurementInterrupted extends Error {
  constructor(message) {
    super(message);
    this.name = 'MeasurementInterrupted';
  }
}

function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, q) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * q;
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  if (lo === hi) return sorted[lo];
  const w = position - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function mad(values) {
  if (!values.length) return NaN;
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function dbfsFromRms(samples) {
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
  const rms = Math.sqrt(sumSq / samples.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

function binToHz(bin, sampleRate) {
  return (bin * sampleRate) / CONFIG.fftSize;
}

function searchHalfWidthHz(targetHz) {
  return 2 + 0.005 * targetHz;
}

function looksBluetooth(label) {
  return /bluetooth|airpods|hands[- ]?free|\bhfp\b|galaxy buds|pixel buds|buds/i.test(label || '');
}

function evidenceLabel(tone) {
  return tone.evidence === 'strong' ? 'Strong persistent'
    : tone.evidence === 'supporting' ? 'Supporting persistent'
      : 'Weak / inconsistent';
}

function processingCaveats(settings) {
  const active = [];
  if (settings.echoCancellation === true) active.push('echo cancellation');
  if (settings.noiseSuppression === true) active.push('noise suppression');
  if (settings.autoGainControl === true) active.push('automatic gain control');
  return active;
}

function getRequestedAudioConstraints() {
  const selected = els.micSelect.value;
  return {
    deviceId: selected ? { exact: selected } : undefined,
    echoCancellation: { ideal: false },
    noiseSuppression: { ideal: false },
    autoGainControl: { ideal: false },
    channelCount: { ideal: 1 },
  };
}

async function refreshDeviceList() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const previous = els.micSelect.value;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === 'audioinput');

  els.micSelect.innerHTML = '<option value="">Default microphone</option>';
  inputs.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Microphone ${index + 1}`;
    els.micSelect.appendChild(option);
  });

  if ([...els.micSelect.options].some((o) => o.value === previous)) {
    els.micSelect.value = previous;
  }
}

function setState(next) {
  appState = next;
}

function stateIsActive() {
  return !['IDLE', 'DONE', 'CANCELLED', 'ERROR', 'INTERRUPTED'].includes(appState);
}

function disableForSession(active) {
  els.micSelect.disabled = active;
  els.startButton.disabled = active;
}

function clearSessionTimers(s) {
  if (!s) return;
  for (const id of s.timeouts) clearTimeout(id);
  s.timeouts.clear();
  if (s.meterTimer) clearInterval(s.meterTimer);
  s.meterTimer = null;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = null;
}

function addSessionTimeout(callback, ms) {
  if (!session) return null;
  const id = setTimeout(() => {
    session?.timeouts.delete(id);
    callback();
  }, ms);
  session.timeouts.add(id);
  return id;
}

async function closeSession(reason = 'normal') {
  const s = session;
  session = null;
  if (!s) {
    disableForSession(false);
    return;
  }

  s.closing = true;
  clearSessionTimers(s);

  document.removeEventListener('visibilitychange', s.handlers.visibility);
  window.removeEventListener('pagehide', s.handlers.pagehide);
  if (navigator.mediaDevices?.removeEventListener) {
    navigator.mediaDevices.removeEventListener('devicechange', s.handlers.devicechange);
  }
  s.track?.removeEventListener('ended', s.handlers.ended);
  s.track?.removeEventListener('mute', s.handlers.mute);

  try { s.source?.disconnect(); } catch (_) {}
  try { s.stream?.getTracks?.().forEach((track) => track.stop()); } catch (_) {}
  try {
    if (s.context && s.context.state !== 'closed') await s.context.close();
  } catch (_) {}

  disableForSession(false);
  els.cancelActiveButton.classList.add('hidden');
  els.meterFill.style.width = '0%';
  if (reason !== 'keep-ui') els.meterLabel.textContent = 'Input level';
}

function interruptActive(message) {
  if (!session || session.closing) return;
  if (activeReject) {
    activeReject(new MeasurementInterrupted(message));
    activeReject = null;
  }
  setState('INTERRUPTED');
  els.interruptionWarning.classList.remove('hidden');
  els.interruptionWarning.innerHTML = `<strong>Measurement interrupted:</strong> ${message} Please retry with this tab visible and the same microphone connected.`;
  closeSession('keep-ui').catch(() => {});
}

function prepareAudioContextFromGesture() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) throw new Error('This browser does not support the Web Audio API.');
  const context = new AudioContextCtor();
  // Invoke resume while the user-activation call stack is still active.
  const resumePromise = context.state === 'suspended' ? context.resume() : Promise.resolve();
  return { context, resumePromise };
}

async function openSession(preparedAudio) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser does not support microphone capture with getUserMedia().');
  }

  await closeSession();
  setState('ACQUIRING');
  disableForSession(true);
  els.interruptionWarning.classList.add('hidden');
  els.processingWarning.classList.add('hidden');
  els.deviceWarning.classList.add('hidden');

  const context = preparedAudio?.context;
  if (!context) throw new Error('Audio engine was not initialized from the user action.');
  await preparedAudio.resumePromise;
  if (context.state === 'suspended') await context.resume();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: getRequestedAudioConstraints(),
      video: false,
    });
  } catch (error) {
    try { await context.close(); } catch (_) {}
    disableForSession(false);
    throw error;
  }

  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    try { await context.close(); } catch (_) {}
    disableForSession(false);
    throw new Error('No audio track was returned by the browser.');
  }
  if (track.muted) {
    stream.getTracks().forEach((t) => t.stop());
    try { await context.close(); } catch (_) {}
    disableForSession(false);
    throw new MeasurementInterrupted('The selected microphone is currently muted or unavailable. Unmute it and try again.');
  }
  const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
  const processingActive = processingCaveats(settings);
  const deviceLabel = track.label || els.micSelect.selectedOptions[0]?.textContent || '';
  const bluetoothLikely = looksBluetooth(deviceLabel);

  let analyser;
  let source;
  try {
    analyser = context.createAnalyser();
    analyser.fftSize = CONFIG.fftSize;
    analyser.smoothingTimeConstant = 0;
    analyser.minDecibels = CONFIG.analyserMinDb;
    analyser.maxDecibels = CONFIG.analyserMaxDb;
    if (analyser.fftSize !== CONFIG.fftSize) {
      throw new Error(`Browser did not keep requested FFT size ${CONFIG.fftSize}.`);
    }
    source = context.createMediaStreamSource(stream);
    source.connect(analyser);
  } catch (error) {
    stream.getTracks().forEach((t) => t.stop());
    try { await context.close(); } catch (_) {}
    disableForSession(false);
    throw error;
  }

  const windowMs = (analyser.fftSize / context.sampleRate) * 1000;
  const hopMs = windowMs * (1 - CONFIG.overlapFraction);

  const s = {
    stream,
    track,
    context,
    source,
    analyser,
    sampleRate: context.sampleRate,
    windowMs,
    hopMs,
    deviceId: settings.deviceId || els.micSelect.value || '',
    processingActive,
    bluetoothLikely,
    label: deviceLabel,
    closing: false,
    timeouts: new Set(),
    meterTimer: null,
    idleTimer: null,
    handlers: {},
  };

  s.handlers.visibility = () => {
    if (document.hidden && stateIsActive()) interruptActive('the browser tab became hidden');
  };
  s.handlers.pagehide = () => {
    closeSession().catch(() => {});
  };
  s.handlers.ended = () => {
    if (!s.closing) interruptActive('the microphone track ended');
  };
  s.handlers.mute = () => {
    if (!s.closing) interruptActive('the microphone source became temporarily unavailable');
  };
  s.handlers.devicechange = async () => {
    if (s.closing || !stateIsActive() || session !== s) return;
    if (s.track.readyState !== 'live') {
      interruptActive('the active microphone device disconnected');
      return;
    }
    const activeId = s.track.getSettings?.().deviceId || s.deviceId;
    if (!activeId || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (session !== s || s.closing) return;
      const stillPresent = devices.some((d) => d.kind === 'audioinput' && d.deviceId === activeId);
      if (!stillPresent) interruptActive('the active microphone device disconnected');
    } catch (_) {
      // A generic devicechange event is not enough evidence to abort a valid measurement.
    }
  };

  document.addEventListener('visibilitychange', s.handlers.visibility);
  window.addEventListener('pagehide', s.handlers.pagehide);
  track.addEventListener('ended', s.handlers.ended);
  track.addEventListener('mute', s.handlers.mute);
  navigator.mediaDevices?.addEventListener?.('devicechange', s.handlers.devicechange);

  session = s;
  els.cancelActiveButton.classList.remove('hidden');

  const timeDomain = new Float32Array(analyser.fftSize);
  s.meterTimer = setInterval(() => {
    if (!session || session !== s || s.context.state === 'closed') return;
    try {
      analyser.getFloatTimeDomainData(timeDomain);
      const rmsDb = dbfsFromRms(timeDomain);
      const normalized = clamp((rmsDb + 70) / 55, 0, 1);
      els.meterFill.style.width = `${(normalized * 100).toFixed(1)}%`;
      els.meterLabel.textContent = Number.isFinite(rmsDb) ? `Input level: ${rmsDb.toFixed(1)} dBFS` : 'Input level: silence';
    } catch (_) {}
  }, 100);

  if (processingActive.length) {
    els.processingWarning.classList.remove('hidden');
    els.processingWarning.innerHTML = `<strong>Browser processing warning:</strong> ${processingActive.join(', ')} still appears enabled. Confidence will be reduced.`;
  }
  if (bluetoothLikely) {
    els.deviceWarning.classList.remove('hidden');
    els.deviceWarning.innerHTML = '<strong>Bluetooth input detected:</strong> voice profiles can filter low frequencies. Results may miss a 50/60 Hz fundamental.';
  }

  refreshDeviceList().catch(() => {});
  return s;
}

async function ensureSessionRunning() {
  if (!session) throw new MeasurementInterrupted('The microphone session is no longer active.');
  if (document.hidden) throw new MeasurementInterrupted('The browser tab is hidden.');
  if (session.track.readyState !== 'live') throw new MeasurementInterrupted('The microphone track is no longer live.');
  if (session.track.muted) throw new MeasurementInterrupted('The microphone is muted or temporarily unavailable.');
  if (session.context.state === 'suspended') {
    await session.context.resume();
  }
  if (session.context.state !== 'running') throw new MeasurementInterrupted('The audio engine is not running.');
}

function guardedCountdown(ms, statusText) {
  return new Promise((resolve, reject) => {
    if (!session) return reject(new MeasurementInterrupted('Microphone session closed.'));
    const started = performance.now();
    activeReject = reject;

    const tick = async () => {
      if (!session) return reject(new MeasurementInterrupted('Microphone session closed.'));
      try {
        await ensureSessionRunning();
      } catch (error) {
        activeReject = null;
        return reject(error);
      }
      const elapsed = performance.now() - started;
      const remaining = Math.max(0, ms - elapsed);
      els.testStatus.textContent = statusText;
      els.countdown.textContent = (remaining / 1000).toFixed(1);
      if (remaining <= 0) {
        activeReject = null;
        resolve();
        return;
      }
      addSessionTimeout(tick, Math.min(100, remaining));
    };
    tick();
  });
}

function binsInRange(lowHz, highHz, sampleRate, spectrumLength) {
  const start = clamp(Math.ceil((lowHz * CONFIG.fftSize) / sampleRate), 1, spectrumLength - 1);
  const end = clamp(Math.floor((highHz * CONFIG.fftSize) / sampleRate), 1, spectrumLength - 1);
  const bins = [];
  for (let b = start; b <= end; b++) bins.push(b);
  return bins;
}

function excludedFromBackground(hz, targetHz) {
  return ALL_EXPECTED.some((expected) =>
    expected !== targetHz && Math.abs(hz - expected) <= CONFIG.exclusionHz
  );
}

function bandMedian(spectrum, bins, targetHz, sampleRate) {
  const kept = bins.filter((bin) => !excludedFromBackground(binToHz(bin, sampleRate), targetHz));
  if (!kept.length) return null;
  return {
    db: median(kept.map((bin) => spectrum[bin])),
    hz: median(kept.map((bin) => binToHz(bin, sampleRate))),
  };
}

function toneProminence(spectrum, targetHz, sampleRate) {
  const half = searchHalfWidthHz(targetHz);
  const searchBins = binsInRange(targetHz - half, targetHz + half, sampleRate, spectrum.length);
  if (!searchBins.length) return null;

  let peakBin = searchBins[0];
  for (const bin of searchBins) {
    if (spectrum[bin] > spectrum[peakBin]) peakBin = bin;
  }

  const leftBins = binsInRange(
    Math.max(1, targetHz - CONFIG.backgroundOuterHz),
    Math.max(1, targetHz - CONFIG.backgroundInnerHz),
    sampleRate,
    spectrum.length
  );
  const rightBins = binsInRange(
    targetHz + CONFIG.backgroundInnerHz,
    targetHz + CONFIG.backgroundOuterHz,
    sampleRate,
    spectrum.length
  );

  const left = bandMedian(spectrum, leftBins, targetHz, sampleRate);
  const right = bandMedian(spectrum, rightBins, targetHz, sampleRate);
  let backgroundDb;

  if (left && right && right.hz !== left.hz) {
    const t = clamp((targetHz - left.hz) / (right.hz - left.hz), 0, 1);
    backgroundDb = left.db + t * (right.db - left.db);
  } else if (left || right) {
    backgroundDb = (left || right).db;
  } else {
    return null;
  }

  const peakDb = spectrum[peakBin];
  return {
    targetHz,
    peakHz: binToHz(peakBin, sampleRate),
    peakDb,
    backgroundDb,
    prominenceDb: peakDb - backgroundDb,
  };
}

function aggregateToneSeries(targetHz, samples) {
  const usable = samples.filter((s) => Number.isFinite(s.prominenceDb));
  if (!usable.length) return null;
  const prominence = usable.map((s) => s.prominenceDb);
  const medianDb = median(prominence);
  const p25Db = percentile(prominence, 0.25);
  const madDb = mad(prominence);
  const peakHz = median(usable.map((s) => s.peakHz));

  let evidence = 'weak';
  if (medianDb >= CONFIG.strongMedianDb && p25Db >= CONFIG.strongP25Db) evidence = 'strong';
  else if (medianDb >= CONFIG.supportMedianDb && p25Db >= CONFIG.supportP25Db) evidence = 'supporting';

  return {
    targetHz,
    peakHz,
    prominenceDb: medianDb,
    medianProminenceDb: medianDb,
    p25ProminenceDb: p25Db,
    madProminenceDb: madDb,
    frameCount: usable.length,
    evidence,
  };
}

function analyzeFamily(name, tones) {
  const usable = tones.filter(Boolean);
  const strong = usable.filter((t) => t.evidence === 'strong');
  const supporting = usable.filter((t) => t.evidence === 'strong' || t.evidence === 'supporting');

  const evidenceScore = supporting.reduce((sum, t) => sum + Math.min(t.medianProminenceDb, 20), 0);

  // V1.25 deliberately requires at least two temporally persistent components
  // before labeling a family pattern. One persistent tone remains a tonal component,
  // not a mains-family classification.
  let confidence = 'None';
  if (strong.length >= 2 && supporting.length >= 3) confidence = 'High';
  else if ((strong.length >= 1 && supporting.length >= 2) || supporting.length >= 3) confidence = 'Medium';
  else if (supporting.length >= 2) confidence = 'Low';

  const topTwo = supporting
    .map((t) => t.medianProminenceDb)
    .sort((a, b) => b - a)
    .slice(0, 2);
  const representative = topTwo.length === 2 ? (topTwo[0] + topTwo[1]) / 2 : 0;

  let strength = 'None';
  if (confidence !== 'None') {
    if (representative >= 18) strength = 'Strong';
    else if (representative >= 10) strength = 'Moderate';
    else if (representative >= CONFIG.supportMedianDb) strength = 'Low';
  }

  return { name, tones: usable, strong, supporting, evidenceScore, confidence, strength };
}

function chooseFamily(family50, family60) {
  const candidates = [family50, family60].sort((a, b) => b.evidenceScore - a.evidenceScore);
  const winner = candidates[0];
  const runnerUp = candidates[1];
  if (winner.confidence === 'None') return { winner: null, runnerUp, ambiguous: false };

  const bothHavePattern = winner.supporting.length >= 2 && runnerUp.supporting.length >= 2;
  const closeScores = Math.abs(winner.evidenceScore - runnerUp.evidenceScore) < 6;
  if (bothHavePattern && closeScores) return { winner, runnerUp, ambiguous: true };
  return { winner, runnerUp, ambiguous: false };
}

async function measureCurrentSession(label = 'Measurement') {
  await ensureSessionRunning();
  const s = session;
  const analyser = s.analyser;
  const fullSpectrum = new Float32Array(analyser.frequencyBinCount);
  const timeDomain = new Float32Array(analyser.fftSize);
  const maxBin = Math.min(
    analyser.frequencyBinCount,
    Math.ceil((CONFIG.maxAnalysisHz * CONFIG.fftSize) / s.sampleRate) + 1
  );

  const series = new Map(ALL_TARGETS.map((t) => [t, []]));
  const rmsSnapshots = [];
  const frameTimes = [];
  const started = performance.now();
  let previousActual = null;
  let frameIndex = 0;

  return new Promise((resolve, reject) => {
    activeReject = reject;

    const tick = async () => {
      if (!session || session !== s) {
        activeReject = null;
        reject(new MeasurementInterrupted('Microphone session closed during measurement.'));
        return;
      }

      try {
        await ensureSessionRunning();
      } catch (error) {
        activeReject = null;
        reject(error);
        return;
      }

      const scheduled = started + frameIndex * s.hopMs;
      const actual = performance.now();
      const elapsed = actual - started;
      const lateness = actual - scheduled;

      if (previousActual !== null && actual - previousActual > s.hopMs * CONFIG.maxGapMultiplier) {
        activeReject = null;
        reject(new MeasurementInterrupted('A large timing gap occurred, likely because the browser or computer paused the page.'));
        return;
      }
      previousActual = actual;

      analyser.getFloatFrequencyData(fullSpectrum);
      analyser.getFloatTimeDomainData(timeDomain);
      const spectrum = fullSpectrum.slice(0, maxBin);
      for (const targetHz of ALL_TARGETS) {
        const tone = toneProminence(spectrum, targetHz, s.sampleRate);
        if (tone) series.get(targetHz).push(tone);
      }
      rmsSnapshots.push(dbfsFromRms(timeDomain));
      frameTimes.push({ scheduledMs: scheduled, actualMs: actual, latenessMs: lateness });

      const remaining = Math.max(0, CONFIG.measurementMs - elapsed);
      els.testStatus.textContent = `${label}: stay quiet — measuring persistent tones…`;
      els.countdown.textContent = (remaining / 1000).toFixed(1);

      frameIndex += 1;
      const nextScheduled = started + frameIndex * s.hopMs;
      if (nextScheduled - started > CONFIG.measurementMs) {
        activeReject = null;
        const tones = ALL_TARGETS.map((t) => aggregateToneSeries(t, series.get(t))).filter(Boolean);
        const toneMap = new Map(tones.map((t) => [t.targetHz, t]));
        const family50 = analyzeFamily('50 Hz', FAMILIES['50 Hz'].map((t) => toneMap.get(t)).filter(Boolean));
        const family60 = analyzeFamily('60 Hz', FAMILIES['60 Hz'].map((t) => toneMap.get(t)).filter(Boolean));
        const chosen = chooseFamily(family50, family60);
        const medianRmsDbfs = median(rmsSnapshots.filter(Number.isFinite));
        resolve({
          result: { family50, family60, chosen },
          metadata: {
            sampleRate: s.sampleRate,
            medianRmsDbfs,
            frameCount: frameTimes.length,
            windowMs: s.windowMs,
            hopMs: s.hopMs,
            actualDurationMs: actual - started,
            processingActive: s.processingActive,
            bluetoothLikely: s.bluetoothLikely,
            lowInput: Number.isFinite(medianRmsDbfs) && medianRmsDbfs < CONFIG.lowInputRmsDbfs,
            deviceId: s.deviceId,
            lateFrameCount: frameTimes.filter((f) => f.latenessMs > Math.max(50, s.hopMs * 0.35)).length,
          },
          frameTimes,
        });
        return;
      }

      const delay = Math.max(0, nextScheduled - performance.now());
      addSessionTimeout(tick, delay);
    };

    tick();
  });
}

function confidenceDown(level) {
  if (level === 'High') return 'Medium';
  if (level === 'Medium') return 'Low';
  return level;
}

function effectiveConfidence(result, metadata) {
  let confidence = result.chosen.winner?.confidence || 'None';
  const caveatCount = [
    metadata.processingActive.length > 0,
    metadata.lowInput,
    metadata.bluetoothLikely,
    metadata.frameCount < 12,
  ].filter(Boolean).length;
  for (let i = 0; i < caveatCount; i++) confidence = confidenceDown(confidence);
  return confidence;
}

function describeMeasurement(result, metadata) {
  const confidence = effectiveConfidence(result, metadata);
  if (!result.chosen.winner) return { pattern: 'No clear pattern', strength: 'None', confidence: '—' };
  if (result.chosen.ambiguous) {
    return { pattern: '50/60 Hz ambiguous', strength: result.chosen.winner.strength, confidence };
  }
  return { pattern: result.chosen.winner.name, strength: result.chosen.winner.strength, confidence };
}

function familyByName(result, name) {
  return name === '50 Hz' ? result.family50 : result.family60;
}

function renderHarmonics(family50, family60) {
  const all = [
    ...family50.tones.map((t) => ({ family: '50 Hz', ...t })),
    ...family60.tones.map((t) => ({ family: '60 Hz', ...t })),
  ].sort((a, b) => a.targetHz - b.targetHz);

  const rows = all.map((t) => `<tr>
      <td>${t.family}</td>
      <td>${t.targetHz} Hz</td>
      <td>${t.peakHz.toFixed(1)} Hz</td>
      <td>${t.medianProminenceDb.toFixed(1)} dB</td>
      <td>${t.p25ProminenceDb.toFixed(1)} dB</td>
      <td>${t.madProminenceDb.toFixed(1)} dB</td>
      <td>${evidenceLabel(t)}</td>
    </tr>`).join('');

  els.harmonicTableWrap.innerHTML = `
    <table class="harmonic-table">
      <thead><tr><th>Family</th><th>Target</th><th>Median peak</th><th>Median prominence</th><th>P25</th><th>MAD</th><th>Evidence</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="small muted">P25 is the lower quartile of per-frame prominence. MAD is shown as a descriptive variability measure; it does not currently change the classification.</p>`;
}

function setResult(measurement) {
  const { result, metadata } = measurement;
  const { family50, family60, chosen } = result;
  const confidence = effectiveConfidence(result, metadata);
  const strength = chosen.winner?.strength || 'None';

  const caveats = [];
  if (metadata.processingActive.length) caveats.push(`Browser-reported processing remains active: ${metadata.processingActive.join(', ')}.`);
  if (metadata.lowInput) caveats.push('The microphone input level was extremely low, so weak tonal measurements may be unreliable.');
  if (metadata.bluetoothLikely) caveats.push('This appears to be a Bluetooth/hands-free microphone. Voice profiles can filter low frequencies.');
  if (metadata.frameCount < 12) caveats.push('This sample rate produced relatively few temporal frames; confidence was reduced.');
  if (metadata.lateFrameCount > 0) caveats.push(`${metadata.lateFrameCount} frame(s) were sampled later than planned; values were retained but timing was not perfectly regular.`);

  if (!chosen.winner) {
    els.resultTitle.textContent = 'No clear 50/60 Hz hum pattern detected';
    els.resultSummary.textContent = 'The test did not find at least two persistent harmonically related components needed to identify a mains-like family pattern. This does not guarantee that your microphone is noise-free.';
    els.patternValue.textContent = 'No clear pattern';
    els.strengthValue.textContent = 'None';
    els.confidenceValue.textContent = '—';
  } else if (chosen.ambiguous) {
    els.resultTitle.textContent = 'Ambiguous mains-like tonal pattern';
    els.resultSummary.textContent = 'Persistent low-frequency tones were detected, but the evidence does not cleanly distinguish a 50 Hz family from a 60 Hz family. Acoustic motors, fans, HVAC systems or other tonal sources can imitate this pattern.';
    els.patternValue.textContent = '50/60 Hz ambiguous';
    els.strengthValue.textContent = strength;
    els.confidenceValue.textContent = confidence;
  } else {
    const high = confidence === 'High';
    const medium = confidence === 'Medium';
    els.resultTitle.textContent = high
      ? `${chosen.winner.name} mains-like hum pattern detected`
      : medium
        ? `Possible ${chosen.winner.name} mains-like hum pattern`
        : `Weak ${chosen.winner.name}-related persistent pattern`;

    els.resultSummary.textContent = high
      ? `Your microphone shows several persistent harmonically related tones consistent with a ${chosen.winner.name} mains-related pattern. This is an observation of the audio spectrum, not proof of a specific hardware fault.`
      : `At least two temporally persistent components were found near the ${chosen.winner.name} family, but the evidence is not strong enough for a high-confidence classification.`;

    els.patternValue.textContent = chosen.winner.name;
    els.strengthValue.textContent = strength;
    els.confidenceValue.textContent = confidence;
  }

  els.sampleRateValue.textContent = `${Math.round(metadata.sampleRate).toLocaleString()} Hz`;
  els.rmsValue.textContent = Number.isFinite(metadata.medianRmsDbfs) ? `${metadata.medianRmsDbfs.toFixed(1)} dBFS` : 'Too low';
  els.snapshotValue.textContent = String(metadata.frameCount);
  els.windowValue.textContent = `${metadata.windowMs.toFixed(0)} ms`;
  els.hopValue.textContent = `${metadata.hopMs.toFixed(0)} ms (50% overlap)`;

  if (caveats.length) {
    els.validityNotice.classList.remove('hidden');
    els.validityNotice.innerHTML = `<strong>Measurement caveat:</strong> ${caveats.join(' ')}`;
  } else {
    els.validityNotice.classList.add('hidden');
    els.validityNotice.textContent = '';
  }

  renderHarmonics(family50, family60);
  els.resultCard.classList.remove('hidden');
  requestAnimationFrame(() => {
    els.resultTitle.focus({ preventScroll: true });
    els.resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function resetComparisonUi() {
  els.comparisonOffer.classList.add('hidden');
  els.comparisonInstructions.classList.add('hidden');
  els.comparisonCard.classList.add('hidden');
  els.comparisonEvidence.innerHTML = '';
  els.comparisonTableWrap.innerHTML = '';
  els.micActiveNotice.classList.add('hidden');
}

function comparisonChanges(beforeFamily, afterFamily) {
  const afterMap = new Map(afterFamily.tones.map((tone) => [tone.targetHz, tone]));
  return beforeFamily.tones.map((before) => {
    const after = afterMap.get(before.targetHz);
    return {
      targetHz: before.targetHz,
      beforeDb: before.medianProminenceDb,
      afterDb: after?.medianProminenceDb ?? NaN,
      deltaDb: after ? after.medianProminenceDb - before.medianProminenceDb : NaN,
      beforeEvidence: before.evidence,
      afterEvidence: after?.evidence || 'weak',
    };
  });
}

function classifyComparison(changes) {
  const relevant = changes.filter((c) => Number.isFinite(c.deltaDb) && c.beforeEvidence !== 'weak');
  const decreases = relevant.filter((c) => c.deltaDb <= -CONFIG.comparisonDeltaDb);
  const increases = relevant.filter((c) => c.deltaDb >= CONFIG.comparisonDeltaDb);

  if (relevant.length >= 2 && decreases.length >= 2 && increases.length === 0) return 'clear-reduction';
  if (decreases.length >= 1 && increases.length === 0) return 'possible-reduction';
  if (decreases.length >= 1 && increases.length >= 1) return 'mixed';
  if (relevant.length >= 2 && increases.length >= 2 && decreases.length === 0) return 'clear-increase';
  if (increases.length >= 1 && decreases.length === 0) return 'possible-increase';
  return 'no-clear-change';
}

function comparisonLabel(kind) {
  const labels = {
    'clear-reduction': 'Clear reduction in the measured pattern',
    'possible-reduction': 'Possible reduction in the measured pattern',
    mixed: 'Mixed change across the harmonic pattern',
    'clear-increase': 'Clear increase in the measured pattern',
    'possible-increase': 'Possible increase in the measured pattern',
    'no-clear-change': 'No clear change in the measured pattern',
  };
  return labels[kind];
}

function renderComparison(beforeMeasurement, afterMeasurement) {
  const targetFamilyName = beforeMeasurement.result.chosen.winner?.name;
  if (!targetFamilyName || beforeMeasurement.result.chosen.ambiguous) return;

  const beforeFamily = familyByName(beforeMeasurement.result, targetFamilyName);
  const afterFamily = familyByName(afterMeasurement.result, targetFamilyName);
  const changes = comparisonChanges(beforeFamily, afterFamily);
  const kind = classifyComparison(changes);
  const beforeDesc = describeMeasurement(beforeMeasurement.result, beforeMeasurement.metadata);
  const afterDesc = describeMeasurement(afterMeasurement.result, afterMeasurement.metadata);

  els.comparisonTitle.textContent = comparisonLabel(kind);
  els.beforePatternValue.textContent = `${beforeDesc.pattern} · ${beforeDesc.strength}`;
  els.beforeConfidenceValue.textContent = `${beforeDesc.confidence === '—' ? 'No' : beforeDesc.confidence} confidence`;
  els.afterPatternValue.textContent = `${afterDesc.pattern} · ${afterDesc.strength}`;
  els.afterConfidenceValue.textContent = `${afterDesc.confidence === '—' ? 'No' : afterDesc.confidence} confidence`;

  const summaryByKind = {
    'clear-reduction': 'Two or more previously persistent components fell by at least the current provisional comparison threshold.',
    'possible-reduction': 'At least one previously persistent component fell by the current provisional comparison threshold, but the family-wide change was not uniform enough to call clear.',
    mixed: 'Some previously persistent components moved down while others moved up. The comparison is not directionally consistent.',
    'clear-increase': 'Two or more previously persistent components rose by at least the current provisional comparison threshold.',
    'possible-increase': 'At least one previously persistent component rose by the current provisional comparison threshold.',
    'no-clear-change': 'The previously persistent family components did not change enough to exceed the current provisional comparison threshold.',
  };
  els.comparisonSummary.textContent = summaryByKind[kind];

  const relevant = changes.filter((c) => c.beforeEvidence !== 'weak' && Number.isFinite(c.deltaDb));
  const strongestDrop = [...relevant].sort((a, b) => a.deltaDb - b.deltaDb)[0];
  const strongestRise = [...relevant].sort((a, b) => b.deltaDb - a.deltaDb)[0];
  const bullets = [];
  if (strongestDrop && strongestDrop.deltaDb <= -CONFIG.comparisonDeltaDb) {
    bullets.push(`<p><strong>Largest reduction:</strong> ${strongestDrop.targetHz} Hz changed from ${strongestDrop.beforeDb.toFixed(1)} dB to ${strongestDrop.afterDb.toFixed(1)} dB (${strongestDrop.deltaDb.toFixed(1)} dB).</p>`);
  }
  if (strongestRise && strongestRise.deltaDb >= CONFIG.comparisonDeltaDb) {
    bullets.push(`<p><strong>Largest increase:</strong> ${strongestRise.targetHz} Hz changed from ${strongestRise.beforeDb.toFixed(1)} dB to ${strongestRise.afterDb.toFixed(1)} dB (+${strongestRise.deltaDb.toFixed(1)} dB).</p>`);
  }
  bullets.push(`<p><strong>Important:</strong> ${CONFIG.comparisonDeltaDb.toFixed(0)} dB is still a provisional engineering threshold. The developer repeatability mode is intended to tell us whether it is conservative enough.</p>`);
  els.comparisonEvidence.innerHTML = `<div class="comparison-evidence-card"><h3>${comparisonLabel(kind)}</h3>${bullets.join('')}</div>`;

  const rows = changes.map((c) => {
    const delta = Number.isFinite(c.deltaDb) ? c.deltaDb : NaN;
    const cls = delta <= -CONFIG.comparisonDeltaDb ? 'delta-down' : delta >= CONFIG.comparisonDeltaDb ? 'delta-up' : 'delta-neutral';
    const deltaText = Number.isFinite(delta) ? `${delta > 0 ? '+' : ''}${delta.toFixed(1)} dB` : '—';
    return `<tr>
      <td>${c.targetHz} Hz</td>
      <td>${c.beforeDb.toFixed(1)} dB</td>
      <td>${Number.isFinite(c.afterDb) ? `${c.afterDb.toFixed(1)} dB` : '—'}</td>
      <td class="${cls}">${deltaText}</td>
      <td>${c.beforeEvidence} → ${c.afterEvidence}</td>
    </tr>`;
  }).join('');
  els.comparisonTableWrap.innerHTML = `
    <table class="harmonic-table">
      <thead><tr><th>${targetFamilyName} component</th><th>Before median</th><th>After median</th><th>Change</th><th>Persistence evidence</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  els.comparisonCard.classList.remove('hidden');
  els.comparisonOffer.classList.add('hidden');
  els.comparisonInstructions.classList.add('hidden');
  els.micActiveNotice.classList.add('hidden');
  requestAnimationFrame(() => {
    els.comparisonTitle.focus({ preventScroll: true });
    els.comparisonCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function userFacingError(error) {
  if (error?.name === 'NotAllowedError') return 'Microphone permission was denied. Allow microphone access and try again.';
  if (error?.name === 'NotFoundError') return 'No microphone was found.';
  if (error?.name === 'OverconstrainedError') return 'The selected microphone is no longer available. Choose another input and try again.';
  if (error?.name === 'NotReadableError') return 'The microphone could not be opened. Another app may be using it, or the device may be unavailable.';
  if (error instanceof MeasurementInterrupted) return error.message;
  return `Microphone error: ${error?.message || error}`;
}

async function startBaseline() {
  if (entryBusy) return;
  entryBusy = true;
  els.startButton.disabled = true;
  els.retestButton.disabled = true;

  let preparedAudio;
  try {
    preparedAudio = prepareAudioContextFromGesture();
  } catch (error) {
    entryBusy = false;
    els.startButton.disabled = false;
    els.retestButton.disabled = false;
    els.interruptionWarning.classList.remove('hidden');
    els.interruptionWarning.textContent = userFacingError(error);
    return;
  }

  baselineMeasurement = null;
  resetComparisonUi();
  els.resultCard.classList.add('hidden');
  els.comparisonCard.classList.add('hidden');
  els.testCard.classList.remove('hidden');
  els.interruptionWarning.classList.add('hidden');
  els.cancelActiveButton.classList.add('hidden');
  els.retestButton.disabled = true;

  try {
    await openSession(preparedAudio);
    setState('WARMUP');
    await guardedCountdown(CONFIG.initialWarmupMs, 'Stabilizing microphone and audio path…');
    setState('MEASURING_BEFORE');
    const measurement = await measureCurrentSession('Baseline');
    baselineMeasurement = measurement;
    els.testCard.classList.add('hidden');
    setResult(measurement);

    const canCompare = measurement.result.chosen.winner && !measurement.result.chosen.ambiguous;
    if (canCompare) {
      setState('WAITING_DECISION');
      els.comparisonOffer.classList.remove('hidden');
      els.micActiveNotice.classList.remove('hidden');
      els.retestButton.disabled = false;
      els.micSelect.disabled = true;
      session.idleTimer = setTimeout(() => {
        if (session && appState === 'WAITING_DECISION') {
          closeSession().catch(() => {});
          setState('DONE');
          els.comparisonOffer.classList.add('hidden');
          els.micActiveNotice.classList.add('hidden');
          els.validityNotice.classList.remove('hidden');
          els.validityNotice.innerHTML += ' <strong>Comparison session timed out:</strong> the microphone was stopped after two minutes of inactivity.';
        }
      }, CONFIG.sessionIdleMs);
    } else {
      await closeSession();
      setState('DONE');
      els.retestButton.disabled = false;
    }
  } catch (error) {
    console.error(error);
    els.testStatus.textContent = 'Test could not complete';
    els.countdown.textContent = '—';
    els.interruptionWarning.classList.remove('hidden');
    els.interruptionWarning.textContent = userFacingError(error);
    await closeSession('keep-ui');
    if (preparedAudio?.context && preparedAudio.context.state !== 'closed') {
      try { await preparedAudio.context.close(); } catch (_) {}
    }
    setState(error instanceof MeasurementInterrupted ? 'INTERRUPTED' : 'ERROR');
    els.retestButton.disabled = false;
  } finally {
    entryBusy = false;
    if (!session) els.startButton.disabled = false;
  }
}

async function startComparisonAfterIntervention() {
  if (!session || !baselineMeasurement) {
    els.interruptionWarning.classList.remove('hidden');
    els.interruptionWarning.textContent = 'The original microphone session is no longer available. Start a fresh baseline test.';
    return;
  }

  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  els.runComparisonButton.disabled = true;
  els.cancelComparisonButton.disabled = false;
  els.retestButton.disabled = true;
  els.testCard.classList.remove('hidden');
  els.cancelActiveButton.classList.remove('hidden');

  try {
    const currentId = session.track.getSettings?.().deviceId || session.deviceId;
    if (session.deviceId && currentId && session.deviceId !== currentId) {
      throw new MeasurementInterrupted('The active microphone device changed between Before and After.');
    }

    setState('SETTLING_AFTER');
    await guardedCountdown(CONFIG.comparisonSettleMs, 'Keep still — waiting for the power-state change to settle…');
    setState('MEASURING_AFTER');
    const afterMeasurement = await measureCurrentSession('After');
    els.testCard.classList.add('hidden');
    renderComparison(baselineMeasurement, afterMeasurement);
    await closeSession();
    setState('DONE');
  } catch (error) {
    console.error(error);
    els.interruptionWarning.classList.remove('hidden');
    els.interruptionWarning.textContent = userFacingError(error);
    await closeSession('keep-ui');
    setState(error instanceof MeasurementInterrupted ? 'INTERRUPTED' : 'ERROR');
  } finally {
    els.runComparisonButton.disabled = false;
    els.cancelComparisonButton.disabled = false;
    els.retestButton.disabled = false;
  }
}

function measurementClassificationLabel(measurement) {
  const desc = describeMeasurement(measurement.result, measurement.metadata);
  return `${desc.pattern} · ${desc.strength} · ${desc.confidence}`;
}

function renderDevValidation(runs) {
  const toneRows = ALL_TARGETS.map((targetHz) => {
    const vals = runs.map((run) => {
      const all = [...run.result.family50.tones, ...run.result.family60.tones];
      return all.find((t) => t.targetHz === targetHz)?.medianProminenceDb ?? NaN;
    });
    const finite = vals.filter(Number.isFinite);
    const acrossMedian = median(finite);
    const acrossMad = mad(finite);
    const range = finite.length ? Math.max(...finite) - Math.min(...finite) : NaN;
    return { targetHz, vals, acrossMedian, acrossMad, range };
  });

  const classifications = runs.map(measurementClassificationLabel);
  const consistent = classifications.every((x) => x === classifications[0]);

  const headerRuns = runs.map((_, i) => `<th>Run ${i + 1}</th>`).join('');
  const rows = toneRows.map((row) => `<tr>
    <td>${row.targetHz} Hz</td>
    ${row.vals.map((v) => `<td>${Number.isFinite(v) ? `${v.toFixed(1)} dB` : '—'}</td>`).join('')}
    <td>${Number.isFinite(row.acrossMedian) ? `${row.acrossMedian.toFixed(1)} dB` : '—'}</td>
    <td>${Number.isFinite(row.acrossMad) ? `${row.acrossMad.toFixed(1)} dB` : '—'}</td>
    <td>${Number.isFinite(row.range) ? `${row.range.toFixed(1)} dB` : '—'}</td>
  </tr>`).join('');

  els.devOutput.innerHTML = `
    <div class="notice info">
      <strong>Classification consistency:</strong> ${consistent ? 'All five runs matched.' : 'The five runs did not all produce the same classification.'}<br>
      ${classifications.map((c, i) => `Run ${i + 1}: ${c}`).join('<br>')}
    </div>
    <div class="table-scroll">
      <table class="harmonic-table">
        <thead><tr><th>Target</th>${headerRuns}<th>Across-run median</th><th>Across-run MAD</th><th>Observed range</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="small muted"><strong>Interpretation rule:</strong> this is only observed same-session run-to-run variation in this room/device state. The range is not a calibrated noise floor and five runs do not establish formal statistical significance.</p>`;
}

async function runDevValidation() {
  if (entryBusy) return;
  entryBusy = true;
  els.devRunButton.disabled = true;
  let preparedAudio;
  try {
    preparedAudio = prepareAudioContextFromGesture();
  } catch (error) {
    entryBusy = false;
    els.devRunButton.disabled = false;
    els.devStatus.textContent = userFacingError(error);
    return;
  }
  els.devCancelButton.classList.remove('hidden');
  els.devOutput.innerHTML = '';
  els.devStatus.textContent = 'Starting microphone session…';
  els.testCard.classList.remove('hidden');
  els.resultCard.classList.add('hidden');
  els.comparisonCard.classList.add('hidden');
  resetComparisonUi();

  const runs = [];
  try {
    await openSession(preparedAudio);
    setState('DEV_WARMUP');
    await guardedCountdown(CONFIG.initialWarmupMs, 'Developer validation: stabilizing microphone…');

    for (let i = 0; i < CONFIG.devRuns; i++) {
      setState(`DEV_RUN_${i + 1}`);
      els.devStatus.textContent = `Running repeatability measurement ${i + 1} of ${CONFIG.devRuns}…`;
      const measurement = await measureCurrentSession(`Repeatability run ${i + 1}/${CONFIG.devRuns}`);
      runs.push(measurement);
      if (i < CONFIG.devRuns - 1) {
        setState('DEV_GAP');
        await guardedCountdown(CONFIG.repeatGapMs, `Keep everything unchanged — gap before run ${i + 2}…`);
      }
    }

    renderDevValidation(runs);
    els.devStatus.textContent = 'Five-run repeatability check complete.';
    els.testCard.classList.add('hidden');
    await closeSession();
    setState('DONE');
  } catch (error) {
    console.error(error);
    els.devStatus.textContent = `Validation interrupted: ${userFacingError(error)}`;
    await closeSession('keep-ui');
    if (preparedAudio?.context && preparedAudio.context.state !== 'closed') {
      try { await preparedAudio.context.close(); } catch (_) {}
    }
    setState(error instanceof MeasurementInterrupted ? 'INTERRUPTED' : 'ERROR');
  } finally {
    entryBusy = false;
    els.devRunButton.disabled = false;
    els.devCancelButton.classList.add('hidden');
  }
}

els.startButton.addEventListener('click', startBaseline);
els.retestButton.addEventListener('click', startBaseline);
els.prepareComparisonButton.addEventListener('click', () => {
  if (!baselineMeasurement || !session) return;
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  setState('AWAITING_INTERVENTION');
  els.comparisonOffer.classList.add('hidden');
  els.comparisonInstructions.classList.remove('hidden');
  els.micActiveNotice.classList.remove('hidden');
  els.retestButton.disabled = true;
  els.micSelect.disabled = true;
  els.comparisonInstructions.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
els.endSessionButton.addEventListener('click', async () => {
  await closeSession();
  setState('DONE');
  els.comparisonOffer.classList.add('hidden');
  els.comparisonInstructions.classList.add('hidden');
  els.micActiveNotice.classList.add('hidden');
  els.retestButton.disabled = false;
});
els.cancelComparisonButton.addEventListener('click', async () => {
  await closeSession();
  setState('CANCELLED');
  els.comparisonInstructions.classList.add('hidden');
  els.comparisonOffer.classList.add('hidden');
  els.micActiveNotice.classList.add('hidden');
  els.testCard.classList.add('hidden');
  els.retestButton.disabled = false;
});
els.runComparisonButton.addEventListener('click', startComparisonAfterIntervention);
els.cancelActiveButton.addEventListener('click', async () => {
  if (activeReject) {
    activeReject(new MeasurementInterrupted('Cancelled by user.'));
    activeReject = null;
  }
  await closeSession();
  setState('CANCELLED');
  els.testCard.classList.add('hidden');
  els.micActiveNotice.classList.add('hidden');
  els.comparisonInstructions.classList.add('hidden');
  els.comparisonOffer.classList.add('hidden');
  els.retestButton.disabled = false;
});
els.newSessionButton.addEventListener('click', async () => {
  await closeSession();
  baselineMeasurement = null;
  resetComparisonUi();
  els.resultCard.classList.add('hidden');
  els.comparisonCard.classList.add('hidden');
  setState('IDLE');
  document.querySelector('.hero')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
els.micSelect.addEventListener('change', () => {
  if (session) return;
  baselineMeasurement = null;
  resetComparisonUi();
  els.resultCard.classList.add('hidden');
  els.comparisonCard.classList.add('hidden');
});
els.devRunButton.addEventListener('click', runDevValidation);
els.devCancelButton.addEventListener('click', async () => {
  if (activeReject) {
    activeReject(new MeasurementInterrupted('Developer validation cancelled by user.'));
    activeReject = null;
  }
  await closeSession();
  setState('CANCELLED');
  els.devStatus.textContent = 'Validation cancelled.';
  els.devRunButton.disabled = false;
  els.devCancelButton.classList.add('hidden');
});

if (new URLSearchParams(location.search).get('dev') === '1') {
  els.devCard.classList.remove('hidden');
}

refreshDeviceList().catch(() => {});
