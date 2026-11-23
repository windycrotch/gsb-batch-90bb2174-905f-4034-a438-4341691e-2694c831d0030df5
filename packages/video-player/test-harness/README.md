# Source-switch lifecycle harness

A self-contained, browser-driven verification suite for the player's **source switch
lifecycle**: what happens when a viewer picks a new video (playlist "next", clicking an
entry, `player.src(...)`) while the previous one is still loading.

Everything is asserted against **what a viewer can see** in the player — poster image,
subtitle text, loading spinner, error banner, chapter markers, seek-thumbnail tooltip,
recommendations and shoppable surfaces. Nothing asserts on console logs or on the
plugin's private fields.

## What it verifies

| Scenario | Checks |
| --- | --- |
| `normal path` | A single switch lands subtitles, poster, chapters and seek thumbnails in order. |
| `stale success` | A slow old switch that resolves after a fast new one does **not** replace the playing video. |
| `stale satellites` | The old source's already-started subtitle/chapter/poster/seek-thumbnail requests landing late never change the new video's UI. |
| `stale failure` | A failing old switch that rejects after the new one committed shows no error. |
| `stale satellite failure` | Late failures of the old source's satellite requests raise no visible error. |
| `new switch fails` | The failing switch itself **does** show its own error, and the previous source's subtitles/poster are not reused. |
| `three rapid switches` | Only the third/last pick's UI survives. |
| `loading endings` | The spinner is dismissed on success, on failure, and when superseded. |
| `playlist next ×2` | Consecutive "next" (or item clicks) keep only the last item's subtitle/poster/chapters/thumbnails. |
| `recommendations / shoppable` | These belong to the committed source only; they don't linger from the previous one. |
| `playlist autoplay` | A superseded playlist item never starts playback later. |

Additional invariants asserted across the stale scenarios: an error banner is **only**
ever raised by the switch that is current, and the loading indicator is hidden in all
three endings (success / failure / superseded).

Against the unfixed player, this suite fails 6 of its 11 scenarios (stale success,
stale satellites, stale failure, the failing-new-switch case, three rapid switches, and
playlist next×2); with the fix in place, all 11 pass. The remaining scenarios are
regression guards for behaviour that was already correct.

## Running

```bash
# from packages/video-player
yarn test:source-switch    # builds the bundle, then runs the suite
```

Or run the suite against an existing build:

```bash
yarn build && node test-harness/run.mjs
node test-harness/run.mjs --filter=stale     # only matching scenarios
node test-harness/run.mjs --verbose          # also print browser-side errors
CHROME_PATH=/path/to/chrome node test-harness/run.mjs
```

Requirements: Node 18+ (uses the global `WebSocket`-free pipe transport, built-in
`fetch`) and a Chrome/Chromium build that supports `--remote-debugging-pipe`
(Chromium 111+). No npm dependencies are added — the suite drives Chrome directly over
the DevTools protocol.

## How it works

- `server.mjs` — a tiny static server: the harness page, the built bundle, and a few
  generated fixtures. Media is a deterministic 12 s WAV generated in memory, so there
  are no binary fixtures. It also serves per-clip posters, subtitle VTTs, chapter VTTs,
  seek-thumbnail tracks and auto-transcript JSON.
- `fixture-driver.mjs` — injected into the page. It wraps `window.fetch` and
  `HTMLImageElement.src` with per-URL **delay / fail / stub-body** rules, so a test can
  make an "old" source slow (or failing) and a "new" one fast. It also exposes
  `visibleState()`, which reads only player-UI state.
- `cdp.mjs` — a minimal DevTools-protocol driver over Chrome's `--remote-debugging-pipe`.
- `run.mjs` — the scenarios and assertions.

The key timing lever: like the real player, the harness starts an old switch, lets it
**commit** its media, then makes its satellite requests (subtitles, poster, chapters,
seek thumbnails) slow or failing. Those land only after the new source has taken over —
exactly the case the lifecycle is meant to drop.
