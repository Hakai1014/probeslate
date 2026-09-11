const $ = id => document.getElementById(id);
const SECONDS = 25;
let stream = null, context = null, node = null, source = null;
let generation = 0, connection = 0, selected = '', busy = false, run = null;
let before = null, after = null, idleTimer = null, watchdog = null;
let cancelPreparation = null;
const text = (id, value) => { $(id).textContent = value; };
function status(message, tone = '') { text('status', message); $('status').dataset.tone = tone; }
function controls() {
  $('start').disabled = busy; $('after').disabled = busy || !before;
  $('reset').disabled = busy; $('mic').disabled = busy; $('keep').disabled = busy;
  $('stop').disabled = !busy && !stream; $('change').disabled = busy;
  $('stop-live').disabled = !busy && !stream;
}
function release() {
  if (cancelPreparation) cancelPreparation();
  $('countdown').hidden = true;
  clearTimeout(idleTimer); clearTimeout(watchdog);
  if (stream) for (const track of stream.getTracks()) {
    track.onmute = null; track.onunmute = null; track.onended = null; track.stop();
  }
  if (node) { node.port.onmessage = null; node.disconnect(); node.port.close(); }
  if (source) source.disconnect();
  if (context) { context.onstatechange = null; void context.close().catch(() => {}); }
  stream = null; context = null; node = null; source = null;
  text('session', 'Microphone released. Results remain on this page.');
  $('meter').value = 0; controls();
}
function cancel(message) {
  generation++; busy = false; run = null; release(); status(message, 'warning'); controls();
}
function showReadingPanel() {
  const panel = $('live-panel');
  const headerHeight = document.querySelector('.site-header')?.getBoundingClientRect().height || 0;
  panel.style.scrollMarginTop = `${headerHeight + 16}px`;
  panel.focus({preventScroll: true});
  panel.scrollIntoView({behavior: 'instant', block: 'start'});
}
function prepare(token) {
  showReadingPanel();
  text('session', 'Microphone connected. Preparing only — the 25-second measurement has not started.');
  return new Promise(resolve => {
    let remaining = 3, timer;
    function finish(ready) {
      clearTimeout(timer);
      cancelPreparation = null;
      $('countdown').hidden = true;
      resolve(ready);
    }
    cancelPreparation = () => finish(false);
    function tick() {
      if (token !== generation || document.hidden) { finish(false); return; }
      if (remaining === 0) { finish(true); return; }
      $('countdown').hidden = false;
      text('countdown', remaining);
      status(`Get ready — start reading in ${remaining}…`);
      text('level', 'Preparing — not measuring');
      remaining--;
      timer = setTimeout(tick, 1000);
    }
    tick();
  });
}
async function devices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    const previous = $('mic').value;
    $('mic').replaceChildren(new Option('Default microphone', ''));
    let n = 0;
    for (const d of list.filter(d => d.kind === 'audioinput')) {
      $('mic').add(new Option(d.label || `Microphone ${++n}`, d.deviceId));
    }
    if ([...$('mic').options].some(o => o.value === previous)) $('mic').value = previous;
  } catch { /* Default input remains usable when device listing is unavailable. */ }
}
function inputEvent(type) {
  if (run) run.events.push({type, time: Math.max(0, (performance.now() - run.start) / 1000)});
  if (type === 'ended') cancel('The microphone disconnected. This run was discarded; reconnect and try again.');
}
async function connect(token) {
  const requested = $('mic').value;
  if (stream && selected === requested && stream.getAudioTracks()[0]?.readyState === 'live' && context?.state === 'running') return true;
  release();
  const acquired = await navigator.mediaDevices.getUserMedia({audio: {
    deviceId: requested ? {exact: requested} : undefined,
    echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1
  }, video: false});
  if (token !== generation) { acquired.getTracks().forEach(t => t.stop()); return false; }
  stream = acquired; selected = requested; connection++;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  context = new AudioContextClass();
  const currentContext = context;
  await currentContext.resume();
  if (token !== generation) return false;
  if (!currentContext.audioWorklet) throw new Error('AudioWorklet is unavailable in this browser. Try a recent browser over HTTPS.');
  await currentContext.audioWorklet.addModule(new URL('./processor.js', import.meta.url));
  if (token !== generation) return false;
  node = new AudioWorkletNode(currentContext, 'stability-processor', {numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit'});
  source = currentContext.createMediaStreamSource(stream); source.connect(node); node.connect(currentContext.destination);
  const track = stream.getAudioTracks()[0];
  track.onmute = () => inputEvent('mute'); track.onunmute = () => inputEvent('unmute'); track.onended = () => inputEvent('ended');
  currentContext.onstatechange = () => {
    if (busy && currentContext.state !== 'running') cancel('Audio processing was interrupted. This run was discarded; start again.');
  };
  node.onprocessorerror = () => cancel('The audio processor stopped. This run was discarded; start again.');
  await devices();
  return token === generation;
}
async function start(kind) {
  if (busy || (kind === 'after' && !before)) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    status('Microphone testing needs HTTPS and a browser with microphone access.', 'error'); return;
  }
  const token = ++generation;
  busy = true; controls(); clearTimeout(idleTimer);
  status('Allow microphone access to begin.');
  $('progress').value = 0; text('clock', '0 / 25 s');
  showReadingPanel();
  try {
    if (!await connect(token)) return;
    if (document.hidden) { cancel('Keep this page visible and start again.'); return; }
    if (!await prepare(token)) return;
    if (token !== generation) return;
    const track = stream.getAudioTracks()[0];
    if (track.readyState !== 'live' || context.state !== 'running') throw new Error('The microphone is not ready. Reconnect it and try again.');
    run = {kind, start: performance.now(), connection, events: [], settings: track.getSettings(),
      label: track.label || 'Microphone', change: $('change').value.trim() || 'No change noted'};
    if (track.muted) run.events.push({type: 'already muted', time: 0});
    node.port.onmessage = ({data}) => {
      if (!run || token !== generation) return;
      if (data.type === 'progress') {
        $('progress').value = data.elapsed; text('clock', `${data.elapsed.toFixed(1)} / 25 s`);
        const db = 20 * Math.log10(Math.max(1e-8, data.rms));
        text('level', db > -50.5 ? 'Signal present' : 'Speak clearly');
        $('meter').value = Math.min(1, Math.max(0, (db + 65) / 60));
      } else if (data.type === 'result') complete(data.result);
    };
    node.port.postMessage({type: 'start', seconds: SECONDS});
    status(`Read the passage aloud — ${kind === 'before' ? 'Before' : 'After'} test running.`);
    text('session', 'Microphone connected. Audio is analyzed locally, with no speaker playback.');
    watchdog = setTimeout(() => { if (run) cancel('Not enough audio arrived in time. This run was discarded; reconnect and try again.'); }, 35000);
    controls();
  } catch (error) {
    if (token !== generation) return;
    busy = false; run = null; release();
    const messages = {
      NotAllowedError: 'Microphone access was denied. Allow it in your browser’s site permissions, then try again.',
      NotFoundError: 'No microphone was found. Connect a microphone and try again.',
      NotReadableError: 'The microphone could not be opened. Check its connection and whether another app is blocking it.',
      OverconstrainedError: 'That microphone is no longer available. Choose another input and try again.'
    };
    status(messages[error.name] || error.message || 'Could not start the test. Please try again.', 'error'); controls();
  }
}
function quality(r) {
  const issues = [];
  if (!r.adequate) issues.push('too little active signal');
  if (r.clippedFraction > 0.001) issues.push('input clipping');
  if (r.events.length) issues.push('input state changes');
  if (r.timingIrregular) issues.push('test timing disruption');
  return issues;
}
function complete(result) {
  clearTimeout(watchdog);
  const finished = {...result, ...run};
  finished.wallDuration = (performance.now() - run.start) / 1000;
  finished.timingIrregular = Math.abs(finished.wallDuration - result.duration) > 1;
  if (run.kind === 'before') { before = finished; after = null; }
  else after = finished;
  run = null; busy = false;
  $('progress').value = SECONDS; text('clock', '25 / 25 s'); text('level', 'Run complete'); $('meter').value = 0;
  render(finished); status('Test complete. Inspect the observations below.');
  if ($('keep').checked) {
    text('session', 'Microphone remains connected for comparison (60 seconds). End session to release it now.');
    idleTimer = setTimeout(() => { if (!busy) release(); }, 60000);
  } else release();
  controls(); $('result-heading').focus({preventScroll: true});
}
function render(r) {
  $('results').hidden = false;
  const issues = quality(r);
  text('result-heading', `${r.kind === 'before' ? 'Before' : 'After'} test results`);
  text('verdict', issues.length ? 'This run is inconclusive. Review the test conditions and repeat.' :
    r.gaps.length || r.impulses.length ? `${r.gaps.length} suspected short dropout(s) and ${r.impulses.length} click-like spike(s) observed. Repeat with everything unchanged first.` :
    'No matching short gaps or isolated click-like spikes were observed during this run.');
  text('quality', issues.length ? `Interpret counts cautiously: ${issues.join(', ')}. These observations do not establish a hardware fault.` :
    'Enough active signal was observed. These are conservative pattern checks, not a guarantee of uninterrupted audio or a diagnosis of your hardware.');
  text('gaps', r.gaps.length); text('longest', r.gaps.length ? `~${Math.round(r.longestGap * 1000)} ms` : '—');
  text('clicks', r.impulses.length); text('quiet', r.quiet.length); text('events', r.events.length);
  text('timing', r.timingIrregular ? 'Irregular' : 'Nominal');
  const timeline = $('timeline'); timeline.replaceChildren();
  const rows = [];
  for (const gap of r.gaps) {
    marker(gap.start, gap.duration, ''); rows.push({time: gap.start, label: `Suspected gap, ~${Math.round(gap.duration * 1000)} ms`});
  }
  for (const time of r.impulses) { marker(time, 0, 'impulse'); rows.push({time, label: 'Click-like spike'}); }
  for (const event of r.events) rows.push({time: event.time, label: `Input: ${event.type}`});
  rows.sort((a, b) => a.time - b.time);
  $('event-list').replaceChildren();
  for (const row of rows) {
    const li = document.createElement('li'); li.textContent = `${row.time.toFixed(3)} s — ${row.label}`; $('event-list').append(li);
  }
  if (!rows.length) { const li = document.createElement('li'); li.textContent = 'No matching signal or input state events.'; $('event-list').append(li); }
  function marker(time, duration, type) {
    const m = document.createElement('span'); m.className = `event-marker ${type}`;
    m.style.left = `${100 * time / SECONDS}%`; m.style.width = `${100 * duration / SECONDS}%`; timeline.append(m);
  }
  const setting = key => r.settings[key] === undefined ? 'not reported' : String(r.settings[key]);
  text('settings', `${r.label} · Analysis: ${r.sampleRate} Hz · Input rate: ${setting('sampleRate')} Hz · Active windows: ${Math.round(r.activeFraction * 100)}% · Clipped samples: ${(r.clippedFraction * 100).toFixed(3)}% · Echo cancellation: ${setting('echoCancellation')} · Noise suppression: ${setting('noiseSuppression')} · Auto gain: ${setting('autoGainControl')} · Algorithm ${r.version}`);
  $('comparison').hidden = !after;
  if (before && after) {
    const sameConnection = before.connection === after.connection;
    const changed = ['deviceId','sampleRate','channelCount','echoCancellation','noiseSuppression','autoGainControl'].filter(k => before.settings[k] !== after.settings[k]);
    let note = sameConnection ? 'Same microphone connection retained.' : 'Microphone reconnected between runs; this is not a same-session capture comparison.';
    if (changed.length) note += ` Reported settings changed: ${changed.join(', ')}.`;
    if (quality(before).length || quality(after).length) note += ' At least one run is inconclusive; do not rank the setups from these counts.';
    else note += ' Counts are observations, not proof that a change fixed the cause. Repeat to check consistency.';
    text('comparison-note', note); text('change-caption', `Change noted: ${after.change}`);
    const data = [['Suspected short dropouts', before.gaps.length, after.gaps.length],
      ['Longest suspected gap', before.gaps.length ? `~${Math.round(before.longestGap * 1000)} ms` : '—', after.gaps.length ? `~${Math.round(after.longestGap * 1000)} ms` : '—'],
      ['Click-like spikes', before.impulses.length, after.impulses.length], ['Near-zero segments', before.quiet.length, after.quiet.length],
      ['Input state events', before.events.length, after.events.length], ['Active windows', `${Math.round(before.activeFraction*100)}%`, `${Math.round(after.activeFraction*100)}%`],
      ['Test quality', quality(before).length ? 'Inconclusive' : 'Adequate', quality(after).length ? 'Inconclusive' : 'Adequate']];
    $('comparison-body').replaceChildren();
    for (const values of data) {
      const tr = document.createElement('tr');
      values.forEach((v, i) => { const cell = document.createElement(i ? 'td' : 'th'); if (!i) cell.scope = 'row'; cell.textContent = v; tr.append(cell); });
      $('comparison-body').append(tr);
    }
  }
}
$('start').addEventListener('click', () => start('before'));
$('after').addEventListener('click', () => start('after'));
$('stop').addEventListener('click', () => cancel(busy ? 'Test cancelled. Microphone released; no partial result was saved.' : 'Session ended. Results remain available.'));
$('stop-live').addEventListener('click', () => cancel(busy ? 'Test cancelled. Microphone released; no partial result was saved.' : 'Session ended. Results remain available.'));
$('reset').addEventListener('click', () => {
  cancel('Ready when you are.'); before = null; after = null; $('results').hidden = true;
  $('comparison').hidden = true; $('change').value = ''; $('progress').value = 0; text('clock', '0 / 25 s'); text('level', 'Waiting for input'); controls();
});
$('mic').addEventListener('change', () => { if (!busy) release(); });
$('keep').addEventListener('change', () => { if (!$('keep').checked && !busy) release(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && (busy || stream)) cancel('Session ended because the page was hidden. Keep it visible for your next run.'); });
window.addEventListener('pagehide', () => cancel('Session ended.'));
navigator.mediaDevices?.addEventListener('devicechange', () => { if (!busy) void devices(); });
controls();
