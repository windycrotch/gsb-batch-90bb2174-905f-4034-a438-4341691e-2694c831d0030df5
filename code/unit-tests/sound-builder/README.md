# Sound Builder — automated tests

Covers repeatable, recoverable instrument application:

- **normal apply** — audio graph topology, master-depth values, modulator frequencies
- **modulator replacement** — re-applying fully replaces frequency/amplitude modulators (no stacking, no leftover oscillators)
- **master depth & enable state** — re-application respects the FM/AM usage toggles
- **filter chain** — enable/disable round-trip, repopulation while enabled or disabled, empty-chain state
- **rollback** — failed load (malformed JSON, too-new format version) and failed apply keep the previous state
- **timing** — rapid consecutive applies; load immediately followed by Apply

Two layers:

- `index.html` — sound-engine tests. A connection-tracking mock of the Web Audio API
  (`mock-audio.js`) replaces the global audio constructors, so the tests assert on actual
  audio node connections and data state, not only on function calls.
- `app-tests.html` — application-level tests. Drives the real, unmodified
  `SoundBuilder/index.html` in an iframe with real UI events and the real Web Audio API.

## Running

```
node run-tests.js
```

The runner launches a headless Chrome or Edge (set `CHROME_PATH` if the browser is not
found in a standard location) and exits non-zero when any test fails.

Alternatively, open `index.html` or `app-tests.html` in a browser directly
(the application-level page needs to be allowed file access, e.g. Chrome with
`--allow-file-access-from-files`).
