# ProbeSlate site v1

Static multi-page production structure.

- `/` homepage
- `/audio/` audio hub
- `/audio/microphone-buzz-test/` validated V1.31 tool
- `/methodology/`
- `/about/`
- `/privacy/`
- `/contact/`

The microphone tool's `app.js` and tool-specific `styles.css` are unchanged from V1.31.

## Microphone Dropout & Crackle Test (beta)

- `/audio/microphone-dropout-test/`: 25-second local AudioWorklet analysis and Before/After comparison.
- Production stays a buildless static site: no API keys or new Cloudflare configuration required. Serve the public site files as before over HTTPS (localhost is also a secure context for development).
- `analyzer.js` contains conservative, versioned signal heuristics; `processor.js` runs them in the audio rendering thread. No raw samples are retained after analysis.
- Tests: `node --test tests/*.test.mjs (Node.js 22.7+ with module syntax detection)`
- Keep the beta label until real microphones and supported browsers have been checked with `tests/manual-checklist.md`. Synthetic checks cannot validate hardware diagnosis.
- Microphone capture can stay connected between runs for 60 seconds if selected; cancellation, hidden pages, input changes and page exit release it. Reconnected A/B runs are explicitly labelled.
- Production deployment remains on the existing publishing branch. Review the feature branch before merging.

### 1.0.1-beta: preparation before both runs

Both Start Before and Run After move focus and scroll to the reading panel. Once
the microphone is connected, a full 3–2–1 countdown runs before a fresh 25-second
measurement begins. Preparation samples and countdown time are excluded. A stop
control is available beside the passage, including on mobile. Cancellation,
page hiding, and context interruptions during preparation release capture.

Run the automated checks with `node --test tests/*.test.mjs` on Node.js 22.7 or newer.
