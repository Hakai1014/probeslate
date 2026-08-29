# ProbeSlate — Microphone Buzz & Hum Test — V1.31

Pre-launch hardening build for `probeslate.com`.

## Measurement engine
The validated V1.25 DSP/classification logic is intentionally unchanged:
- Web Audio `AnalyserNode`, FFT size 32768
- actual AudioContext sample rate
- 50% best-effort temporal overlap
- per-frame prominence, median + P25 persistence
- 50 Hz / 60 Hz harmonic-family classification
- same-session Before/After comparison

## V1.31 hardening changes
- synchronous Start/Retest reentrancy guard to prevent orphaned microphone sessions
- AudioContext is created/resume-invoked directly in the user gesture path for Safari/WebKit
- explicit analyser range: -100 dB to -10 dB
- acquisition-time and in-session muted-track checks
- `devicechange` only interrupts when the active input disappears
- all MediaStream tracks are stopped during cleanup
- friendlier Overconstrained/NotReadable errors
- live-region scoping fixed so the 10 Hz meter/countdown does not flood screen readers
- result/comparison focus management
- real mobile navigation instead of hiding the links
- ProbeSlate branding, canonical URL and Open Graph metadata

## Still intentionally provisional
- comparison effect threshold remains an engineering heuristic
- browser/OS DSP can alter low-frequency content
- the tool observes a mains-like spectral pattern; it does not prove a physical ground loop or faulty component

## Regression gate before launch
1. Normal quiet test → should not invent a mains-family pattern.
2. 50 Hz-family positive-control WAV → should detect the 50 Hz family.
3. Single clap/transient → should not classify a family.
4. Rapidly click Start several times → only one mic session should exist; Cancel/End must fully release the browser mic indicator.
