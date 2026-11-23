/**
 * Source-switch lifecycle verification (browser-visible state only).
 *
 * Each scenario drives the real built player in headless Chrome and asserts on what a
 * viewer can see: poster, subtitle text, spinner, error banner, chapter markers,
 * seek-thumbnail tooltip, "up next"/recommendations/shoppable surfaces. Nothing here
 * asserts on console logs or on the plugin's internal fields.
 *
 * Run: node packages/video-player/test-harness/run.mjs
 *      node packages/video-player/test-harness/run.mjs --filter=stale-failure
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage } from './cdp.mjs';
import { startFixtureServer } from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

const args = process.argv.slice(2);
const filter = (args.find((a) => a.startsWith('--filter=')) || '').split('=')[1] || '';
const verbose = args.includes('--verbose');

// ── tiny assertion helpers ────────────────────────────────────────────────────
class AssertionError extends Error {}
const assert = {
  ok(value, message) {
    if (!value) throw new AssertionError(message);
  },
  equal(actual, expected, message) {
    if (actual !== expected) {
      throw new AssertionError(`${message}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  },
  includes(haystack, needle, message) {
    if (!haystack || !haystack.includes(needle)) {
      throw new AssertionError(`${message}\n    expected to contain: ${JSON.stringify(needle)}\n    actual: ${JSON.stringify(haystack)}`);
    }
  },
  notIncludes(haystack, needle, message) {
    if (haystack && haystack.includes(needle)) {
      throw new AssertionError(`${message}\n    expected NOT to contain: ${JSON.stringify(needle)}\n    actual: ${JSON.stringify(haystack)}`);
    }
  },
  notEqual(actual, unexpected, message) {
    if (actual === unexpected) {
      throw new AssertionError(`${message}\n    expected not: ${JSON.stringify(unexpected)}`);
    }
  },
};

// ── page-side helpers, injected once per page ─────────────────────────────────
const PRELUDE = String.raw`
window.__h = {
  wait(fn, ms, label) { return window.__fixture.waitFor(fn, ms, label); },
  sleep(ms) { return window.__fixture.sleep(ms); },
  state() { return window.__fixture.visibleState(); },
  async boot(options) {
    const f = window.__fixture;
    window.__errors = [];
    window.__player = f.createPlayer(options || {});
    window.__player.on('error', () => window.__errors.push(window.__player.error()?.message || ''));
    return true;
  },
  loadA(opts) {
    window.__fixture.load({
      src: '/media/clipA.wav',
      info: { title: 'Clip A' },
      poster: { src: '/img/posterA.svg' },
      textTracks: [{ src: '/subs/clipA.vtt', srclang: 'en', label: 'English', default: true }],
      chapters: { url: '/chapters/clipA.vtt' },
      ...(opts || {}),
    });
  },
  loadB(opts) {
    window.__fixture.load({
      src: '/media/clipB.wav',
      info: { title: 'Clip B' },
      poster: { src: '/img/posterB.svg' },
      textTracks: [{ src: '/subs/clipB.vtt', srclang: 'en', label: 'English', default: true }],
      chapters: { url: '/chapters/clipB.vtt' },
      ...(opts || {}),
    });
  },
  loadC(opts) {
    window.__fixture.load({
      src: '/media/clipC.wav',
      info: { title: 'Clip C' },
      poster: { src: '/img/posterC.svg' },
      textTracks: [{ src: '/subs/clipC.vtt', srclang: 'en', label: 'English', default: true }],
      chapters: { url: '/chapters/clipC.vtt' },
      ...(opts || {}),
    });
  },
  spinnerHidden() {
    const el = window.__player.el().querySelector('.vjs-loading-spinner');
    return !el || getComputedStyle(el).display === 'none';
  },
  chapterCount() { return window.__player.el().querySelectorAll('.vjs-chapter-boundary').length; },
  cueTexts() { return [...window.__player.el().querySelectorAll('.vjs-text-track-cue')].map(e => e.textContent.trim()).filter(Boolean); },
  posterSrc() { return window.__player.poster(); },
  currentSrc() { return window.__player.currentSrc(); },
  errorText() {
    const el = window.__player.el().querySelector('.vjs-error-display');
    if (!el || !window.__player.el().classList.contains('vjs-error')) return '';
    return (el.textContent || '').trim();
  },
  async hoverProgressBar() { return window.__fixture.hoverProgressBar(); },
  async getCue(el) { return el ? el.textContent.trim() : null; },
};
`;

const scenarios = [];
function scenario(name, fn) {
  scenarios.push({ name, fn });
}

// ── scenario 1: normal path, nothing superseded ──────────────────────────────
scenario('normal path: subtitles, poster, chapters, seek thumbnails all land', async (page) => {
  const r = JSON.parse(await page.evaluate(`(async () => {
    await window.__h.boot();
    window.__h.loadA();
    const player = window.__player;
    await window.__h.wait(() => player.readyState() >= 1, 15000, 'metadata');
    await window.__h.wait(() => window.__h.cueTexts().length > 0, 8000, 'subtitle cue');
    await window.__h.wait(() => window.__h.chapterCount() > 0, 8000, 'chapter marker');
    await window.__h.wait(() => window.__h.posterSrc().includes('posterA'), 8000, 'poster A');
    // The seek-thumbnail VTT is fetched during the source switch.
    await window.__h.wait(() => window.__player.el().querySelector('.thumbnail-preview'), 8000, 'seek-thumbnail container');
    const thumb = await window.__h.hoverProgressBar();
    const st = window.__h.state();
    return JSON.stringify({ st, thumb, chapterCount: window.__h.chapterCount(), errors: window.__errors });
  })()`));

  assert.deepEqualCues(r.st.cues, ['subtitle clipA'], 'the active subtitle is clip A\'s');
  assert.includes(r.st.poster, 'posterA', 'the poster is clip A\'s');
  assert.ok(r.chapterCount >= 1, 'clip A chapter markers are rendered');
  assert.ok(r.thumb && r.thumb.visible, 'the seek-thumbnail tooltip is visible on hover');
  assert.includes(r.thumb.backgroundImage, 'sprite-clipA', 'the seek thumbnail is clip A\'s sprite');
  assert.ok(await page.evaluate('window.__h.spinnerHidden()'), 'loading spinner is hidden once loading settles');
  assert.equal(r.st.errorVisible, false, 'no error is shown on the normal path');
  assert.ok(r.errors.every((e) => !e), 'no player error was raised');
});

// ── scenario 2: old switch is slow at the probe step, new switch is fast ────
scenario('stale success: a slow old switch cannot load over the fast new one', async (page) => {
  const r = JSON.parse(await page.evaluate(`(async () => {
    await window.__h.boot();
    // The switch awaits a HEAD probe of the media URL before committing it. Delay
    // clip A's probe (a fetch) far past clip B's, so A is still in flight when B is
    // picked — and A's probe resolves only after B has fully committed.
    window.__fixture.setRules([{ pattern: 'clipA\\\\.wav$', delay: 1500 }]);
    window.__h.loadA();
    await window.__h.sleep(120);          // A is now waiting on its (slow) probe
    const afterA = window.__h.state();

    window.__fixture.clearRules();
    window.__h.loadB();                    // B is fast and must win
    await window.__h.wait(() => window.__h.currentSrc().includes('clipB'), 15000, 'clip B attached');
    await window.__h.wait(() => window.__h.cueTexts().some(t => t === 'subtitle clipB'), 10000, 'clip B cue');

    // Let A's delayed probe resolve now: if the old switch still commits, the media
    // element switches back to clip A.
    await window.__h.sleep(2200);
    const settled = window.__h.state();
    const thumb = await window.__h.hoverProgressBar();
    return JSON.stringify({ afterA, settled, thumb, errors: window.__errors });
  })()`));

  assert.ok(r.afterA.spinnerVisible || r.afterA.waitingClass, 'loading is shown while the slow switch is in flight');
  assert.includes(r.settled.currentSrc, 'clipB', 'the media element still plays clip B (the stale switch did not commit)');
  assert.deepEqualCues(r.settled.cues, ['subtitle clipB'], 'only clip B\'s subtitle is painted');
  assert.includes(r.settled.poster, 'posterB', 'the poster is clip B\'s, not the stale clip A one');
  assert.ok(r.thumb && r.thumb.backgroundImage && r.thumb.backgroundImage.includes('sprite-clipB'), 'seek thumbnails are clip B\'s sprite');
  assert.equal(r.settled.errorVisible, false, 'the superseded switch did not raise an error');
  assert.ok(r.settled.chapterCues.every((c) => !c.includes('clipA')), `no clip A chapter text (saw ${JSON.stringify(r.settled.chapterCues)})`);
  assert.ok(await page.evaluate('window.__h.spinnerHidden()'), 'loading spinner is hidden at the end');
  assert.ok(r.errors.every((e) => !e), 'no player error was raised');
});

// ── scenario 2b: satellites of an already-committed old switch land late ────
scenario('stale satellites: epilogue requests of the old source never land on the new one', async (page) => {
  const r = JSON.parse(await page.evaluate(`(async () => {
    const f = window.__fixture;
    await window.__h.boot();
    // Clip A commits quickly, but its *satellite* work is slow: subtitle signing,
    // poster signing, chapter VTT fetch and seek-thumbnail VTT fetch all resolve long
    // after clip B has taken over. These run after the switch committed, so a stale
    // success here is exactly what the viewer would see as "old subtitles/thumbnails".
    f.setSignerRules([
      { pattern: 'subs/clipA', delay: 1500 },
      { pattern: 'posterA', delay: 1500 },
    ]);
    f.setRules([
      { pattern: 'chapters/clipA', delay: 1500 },
      { pattern: 'clipA\\\\.wav/ik-seek-thumbnail-track', delay: 1500 },
    ]);
    window.__h.loadA();
    await window.__h.wait(() => window.__h.currentSrc().includes('clipA'), 10000, 'clip A committed');

    window.__h.loadB();                 // fast; its satellites finish immediately
    await window.__h.wait(() => window.__h.cueTexts().some(t => t === 'subtitle clipB'), 10000, 'clip B cue');
    await window.__h.wait(() => window.__h.posterSrc().includes('posterB'), 8000, 'clip B poster');

    // Now A's satellites land. Nothing of A may appear.
    await window.__h.sleep(2600);
    const settled = window.__h.state();
    const thumb = await window.__h.hoverProgressBar();
    return JSON.stringify({ settled, thumb, errors: window.__errors });
  })()`));

  assert.includes(r.settled.currentSrc, 'clipB', 'the media element still plays clip B');
  assert.deepEqualCues(r.settled.cues, ['subtitle clipB'], 'only clip B\'s subtitle is painted, not the late clip A one');
  assert.ok(r.settled.subtitleTrackText.every((t) => !t.includes('clipA')), `no clip A subtitle track content (saw ${JSON.stringify(r.settled.subtitleTrackText)})`);
  assert.includes(r.settled.poster, 'posterB', 'the poster is clip B\'s, not the late clip A one');
  assert.ok(r.settled.chapterCues.every((c) => !c.includes('clipA')), `no clip A chapter text (saw ${JSON.stringify(r.settled.chapterCues)})`);
  assert.ok(r.thumb && r.thumb.backgroundImage && r.thumb.backgroundImage.includes('sprite-clipB'), 'seek thumbnails are clip B\'s sprite, not the late clip A one');
  assert.equal(r.settled.errorVisible, false, 'no error was raised');
});

// ── scenario 3: old switch fails at its probe after the new one committed ────
scenario('stale failure: a failing old switch cannot show an error over the new video', async (page) => {
  const r = JSON.parse(await page.evaluate(`(async () => {
    await window.__h.boot();
    // Clip A's probe fails, but only after the viewer already picked clip B.
    window.__fixture.setRules([{ pattern: 'clipA\\\\.wav$', delay: 900, fail: true }]);
    window.__h.loadA();
    await window.__h.sleep(120);
    const beforeB = window.__h.state();

    window.__fixture.clearRules();
    window.__h.loadB();
    await window.__h.wait(() => window.__h.cueTexts().some(t => t === 'subtitle clipB'), 15000, 'clip B cue');

    // Let clip A's failing probe settle now.
    await window.__h.sleep(1800);
    const settled = window.__h.state();
    return JSON.stringify({ beforeB, settled, errors: window.__errors });
  })()`));

  assert.ok(r.beforeB.spinnerVisible || r.beforeB.waitingClass, 'loading is shown while the failing switch is in flight');
  assert.deepEqualCues(r.settled.cues, ['subtitle clipB'], 'clip B\'s subtitle is still the one painted');
  assert.includes(r.settled.poster, 'posterB', 'clip B\'s poster is still shown');
  assert.equal(r.settled.errorVisible, false, 'the superseded failure did not produce a visible error');
  assert.equal(r.settled.errorText, '', 'no error text is shown');
  assert.ok(await page.evaluate('window.__h.spinnerHidden()'), 'loading spinner is hidden at the end');
  assert.ok(r.errors.every((e) => !e), 'no player error was raised');
});

// ── scenario 3b: satellites of the committed old source fail late ────────────
scenario('stale satellite failure: a late failure of the old source cannot raise an error', async (page) => {
  const r = JSON.parse(await page.evaluate(`(async () => {
    const f = window.__fixture;
    await window.__h.boot();
    // Clip A commits fast, then its satellite work fails late (its seek-thumbnail VTT
    // fetch and chapter fetch reject, its poster signing fails) — all after clip B is
    // already the video being watched.
    f.setSignerRules([{ pattern: 'posterA', delay: 1400, fail: true }]);
    f.setRules([
      { pattern: 'chapters/clipA', delay: 1400, fail: true },
      { pattern: 'clipA\\\\.wav/ik-seek-thumbnail-track', delay: 1400, fail: true },
    ]);
    window.__h.loadA();
    await f.waitFor(() => window.__h.currentSrc().includes('clipA'), 10000, 'clip A committed');

    window.__h.loadB();
    await window.__h.wait(() => window.__h.cueTexts().some(t => t === 'subtitle clipB'), 12000, 'clip B cue');

    await window.__h.sleep(2600);
    const settled = window.__h.state();
    return JSON.stringify({ settled, errors: window.__errors });
  })()`));

  assert.includes(r.settled.currentSrc, 'clipB', 'the media element still plays clip B');
  assert.deepEqualCues(r.settled.cues, ['subtitle clipB'], 'clip B\'s subtitle is painted');
  assert.equal(r.settled.errorVisible, false, 'a late failure of the old source did not raise a visible error');
  assert.equal(r.settled.errorText, '', 'no error text is shown');
  assert.ok(await page.evaluate('window.__h.spinnerHidden()'), 'loading spinner is hidden at the end');
  assert.ok(r.errors.every((e) => !e), 'no player error was raised');
});

// ── scenario 4: new switch itself fails → its error must show ────────────────
scenario('new switch fails: its own error is shown, and old data is not used', async (page) => {
  const r = JSON.parse(await page.evaluate(`(async () => {
    await window.__h.boot();
    window.__h.loadA();
    await window.__h.wait(() => window.__h.cueTexts().some(t => t === 'subtitle clipA'), 15000, 'clip A ready');
    const withA = window.__h.state();

    // Clip B signing fails outright: this switch has nothing to show.
    window.__fixture.setSignerRules([{ pattern: 'clipB', fail: true }]);
    window.__h.loadB();
    const player = window.__player;
    await window.__h.wait(() => window.__h.errorText().length > 0, 12000, 'clip B error');
    await window.__h.sleep(400);
    const settled = window.__h.state();
    return JSON.stringify({ withA, settled });
  })()`));

  assert.deepEqualCues(r.withA.cues, ['subtitle clipA'], 'clip A was showing before the switch');
  assert.equal(r.settled.errorVisible, true, 'the failing switch shows an error');
  assert.includes(r.settled.errorText, 'signing failed', 'the error describes the failing switch');
  assert.deepEqualCues(r.settled.cues, [], 'clip A\'s subtitles are not reused for the failed switch');
  assert.notIncludes(r.settled.poster, 'posterA', 'clip A\'s poster is not kept');
  assert.ok(await page.evaluate('window.__h.spinnerHidden()'), 'loading spinner is hidden on failure too');
});

// ── scenario 5: three rapid switches → only the last survives ────────────────
scenario('three rapid switches: only the last one\'s UI survives', async (page) => {
  const r = JSON.parse(await page.evaluate(`(async () => {
    const f = window.__fixture;
    await window.__h.boot();
    // Each earlier source commits quickly, but its epilogue requests (subtitle,
    // chapter, poster, seek-thumbnail Vtt) are progressively slower, so all of the
    // A and B work lands only after C has taken over the player.
    f.setSignerRules([
      { pattern: 'subs/clipA', delay: 2200 },
      { pattern: 'posterA', delay: 2200 },
      { pattern: 'subs/clipB', delay: 1400 },
      { pattern: 'posterB', delay: 1400 },
    ]);
    f.setRules([
      { pattern: 'chapters/clipA', delay: 2200 },
      { pattern: 'clipA\\\\.wav/ik-seek-thumbnail-track', delay: 2200 },
      { pattern: 'chapters/clipB', delay: 1400 },
      { pattern: 'clipB\\\\.wav/ik-seek-thumbnail-track', delay: 1400 },
    ]);
    window.__h.loadA();
    await f.waitFor(() => window.__h.currentSrc().includes('clipA'), 10000, 'A committed');
    window.__h.loadB();
    await f.waitFor(() => window.__h.currentSrc().includes('clipB'), 10000, 'B committed');
    window.__h.loadC();

    await window.__h.wait(() => window.__h.currentSrc().includes('clipC'), 15000, 'clip C attached');
    await window.__h.wait(() => window.__h.cueTexts().some(t => t === 'subtitle clipC'), 12000, 'clip C cue');

    // Everything delayed in A and B has landed by now.
    await window.__h.sleep(3200);
    const settled = window.__h.state();
    const thumb = await window.__h.hoverProgressBar();
    return JSON.stringify({ settled, thumb, chapterCount: window.__h.chapterCount(), errors: window.__errors });
  })()`));

  assert.includes(r.settled.currentSrc, 'clipC', 'the media element plays clip C');
  assert.deepEqualCues(r.settled.cues, ['subtitle clipC'], 'only clip C\'s subtitle is painted');
  assert.ok(r.settled.subtitleTrackText.every((t) => !t.includes('clipA') && !t.includes('clipB')), `no stale A/B subtitle content (saw ${JSON.stringify(r.settled.subtitleTrackText)})`);
  assert.includes(r.settled.poster, 'posterC', 'the poster is clip C\'s');
  assert.ok(r.thumb && r.thumb.backgroundImage && r.thumb.backgroundImage.includes('sprite-clipC'), 'seek thumbnails are clip C\'s');
  assert.ok(r.settled.chapterCues.every((c) => !c.includes('clipA') && !c.includes('clipB')), `only clip C chapter text (saw ${JSON.stringify(r.settled.chapterCues)})`);
  assert.equal(r.settled.errorVisible, false, 'no error from the superseded switches');
  assert.ok(await page.evaluate('window.__h.spinnerHidden()'), 'loading spinner is hidden at the end');
  assert.ok(r.errors.every((e) => !e), 'no player error was raised');
});

// ── scenario 6: superseded switch does not leak its spinner/loading state ────
scenario('loading resolves on all three endings (success, failure, superseded)', async (page) => {
  const r = JSON.parse(await page.evaluate(`(async () => {
    await window.__h.boot();
    const player = window.__player;
    const out = {};

    // success
    window.__h.loadA();
    await window.__h.wait(() => player.readyState() >= 1 && window.__h.currentSrc().includes('clipA'), 15000, 'A');
    await window.__h.sleep(200);
    out.successSpinnerHidden = window.__h.spinnerHidden();

    // superseded: A2 stays in flight, B replaces it; the spinner belongs to B and must settle
    window.__fixture.setSignerRules([{ pattern: 'clipA', delay: 3000 }]);
    window.__h.loadA();
    await window.__h.sleep(100);
    window.__fixture.clearSignerRules();
    window.__h.loadB();
    await window.__h.wait(() => window.__h.cueTexts().some(t => t === 'subtitle clipB'), 15000, 'B');
    await window.__h.sleep(200);
    out.supersededSpinnerHidden = window.__h.spinnerHidden();

    // failure
    window.__fixture.setSignerRules([{ pattern: 'clipC', fail: true }]);
    window.__h.loadC();
    await window.__h.wait(() => window.__h.errorText().length > 0, 12000, 'C error');
    await window.__h.sleep(200);
    out.failureSpinnerHidden = window.__h.spinnerHidden();
    out.failureErrorShown = window.__h.errorText().length > 0;
    return JSON.stringify(out);
  })()`));

  assert.equal(r.successSpinnerHidden, true, 'spinner hidden after a successful switch');
  assert.equal(r.supersededSpinnerHidden, true, 'spinner hidden after a superseded switch');
  assert.equal(r.failureSpinnerHidden, true, 'spinner hidden after a failed switch');
  assert.equal(r.failureErrorShown, true, 'the failing switch shows its error');
});

// ── scenario 7: playlist next/next keeps only the last pick's UI ─────────────
scenario('playlist: consecutive "next" keeps only the last item\'s UI', async (page) => {
  const r = JSON.parse(await page.evaluate(`(async () => {
    const f = window.__fixture;
    // Each earlier item commits quickly, but its subtitle/chapter/poster/seek-thumbnail
    // requests are slow, so they all land only after the viewer has moved on to C.
    f.setSignerRules([
      { pattern: 'subs/clipA', delay: 2200 }, { pattern: 'posterA', delay: 2200 },
      { pattern: 'subs/clipB', delay: 1400 }, { pattern: 'posterB', delay: 1400 },
    ]);
    f.setRules([
      { pattern: 'chapters/clipA', delay: 2200 }, { pattern: 'clipA\\\\.wav/ik-seek-thumbnail-track', delay: 2200 },
      { pattern: 'chapters/clipB', delay: 1400 }, { pattern: 'clipB\\\\.wav/ik-seek-thumbnail-track', delay: 1400 },
    ]);

    const item = (clip, color) => f.source({
      src: '/media/' + clip + '.wav',
      info: { title: clip },
      poster: { src: '/img/poster' + clip.slice(-1) + '.svg' },
      textTracks: [{ src: '/subs/' + clip + '.vtt', srclang: 'en', label: 'English', default: true }],
      chapters: { url: '/chapters/' + clip + '.vtt' },
    });
    const player = f.createPlayer();
    const manager = player.playlist({
      sources: [item('clipA'), item('clipB'), item('clipC')],
      options: { autoAdvance: false, repeat: true },
    });

    manager.loadPlaylistItem(0);   // A commits; its epilogue is slow
    await f.waitFor(() => f.visibleState().currentSrc.includes('clipA'), 10000, 'A committed');
    manager.loadPlaylistItem(1);   // B commits; its epilogue is slow
    await f.waitFor(() => f.visibleState().currentSrc.includes('clipB'), 10000, 'B committed');
    manager.loadPlaylistItem(2);   // C (fast) — the one the viewer ends on

    await f.waitFor(() => f.visibleState().currentSrc.includes('clipC'), 15000, 'C attached');
    await f.waitFor(() => f.visibleState().cues.some(t => t === 'subtitle clipC'), 12000, 'C cue');
    await f.sleep(3200);
    return JSON.stringify({ settled: f.visibleState(), thumb: await f.hoverProgressBar() });
  })()`));

  assert.includes(r.settled.currentSrc, 'clipC', 'the playlist ends on clip C');
  assert.deepEqualCues(r.settled.cues, ['subtitle clipC'], 'only the last item\'s subtitle is painted');
  assert.ok(r.settled.subtitleTrackText.every((t) => !t.includes('clipA') && !t.includes('clipB')), `no stale playlist subtitle content (saw ${JSON.stringify(r.settled.subtitleTrackText)})`);
  assert.includes(r.settled.poster, 'posterC', 'only the last item\'s poster is shown');
  assert.ok(r.thumb && r.thumb.backgroundImage && r.thumb.backgroundImage.includes('sprite-clipC'), 'seek thumbnails are the last item\'s');
  assert.ok(r.settled.chapterCues.every((c) => !c.includes('clipA') && !c.includes('clipB')), `only the last item's chapter text (saw ${JSON.stringify(r.settled.chapterCues)})`);
  assert.equal(r.settled.errorVisible, false, 'no error from the superseded playlist items');
});

// ── scenario 8: old source's recommendations must not show for the new one ──
scenario('recommendations and shoppable belong to the committed source only', async (page) => {
  const r = JSON.parse(await page.evaluate(`(async () => {
    const f = window.__fixture;
    const player = f.createPlayer();
    const out = {};

    // Clip A carries its own products and recommendations.
    f.load({
      src: '/media/clipA.wav',
      info: { title: 'Clip A' },
      poster: { src: '/img/posterA.svg' },
      recommendations: [f.source({ src: '/media/clipB.wav', info: { title: 'Recommended B' } })],
      shoppable: { startState: 'open', products: [{ productId: 7, productName: 'Product A', imageUrl: '/img/sprite-clipA.svg' }] },
    });
    await f.waitFor(() => f.visibleState().shoppableProducts.includes('Product A'), 15000, 'A shoppable');
    out.aProducts = f.visibleState().shoppableProducts;

    // Clip B has neither: neither surface may linger from A.
    f.load({ src: '/media/clipB.wav', info: { title: 'Clip B' }, poster: { src: '/img/posterB.svg' } });
    await f.waitFor(() => f.visibleState().currentSrc.includes('clipB'), 15000, 'B attached');
    await f.sleep(400);
    out.bProducts = f.visibleState().shoppableProducts;
    out.bRecs = f.visibleState().recTitles;
    return JSON.stringify(out);
  })()`));

  assert.includes(r.aProducts.join(','), 'Product A', 'clip A shows its shoppable product');
  assert.equal(r.bProducts.length, 0, 'clip B shows none of clip A\'s products');
  assert.equal(r.bRecs.length, 0, 'clip B shows none of clip A\'s recommendations');
});

// ── scenario 9: autoplay from a superseded playlist item doesn't fire ───────
scenario('playlist autoplay: a superseded item does not start playback later', async (page) => {
  const r = JSON.parse(await page.evaluate(`(async () => {
    const f = window.__fixture;
    f.setSignerRules([{ pattern: 'clipA', delay: 1200 }]);
    f.setRules([{ pattern: 'clipA', delay: 1200 }]);
    const item = (clip) => f.source({ src: '/media/' + clip + '.wav', info: { title: clip } });
    const player = f.createPlayer();
    const manager = player.playlist({
      sources: [item('clipA'), item('clipB')],
      options: { autoAdvance: false, repeat: true },
    });
    const plays = [];
    player.on('play', () => plays.push(f.visibleState().currentSrc));

    // Seed the current index at item 0 without waiting for it, then advance to A.
    player.playlistMenu; // menu exists; index is still null until a load call
    manager.loadPlaylistItem(0);   // A is slow; its loadstart would trigger autoplay
    await f.sleep(80);
    f.clearSignerRules();
    f.clearRules();
    manager.playNext();            // B (current index 0 -> 1), fast; this is the winner

    await f.waitFor(() => f.visibleState().currentSrc.includes('clipB'), 15000, 'B attached');
    await f.sleep(2200);           // A's metadata window has long passed
    return JSON.stringify({ plays, currentSrc: f.visibleState().currentSrc, paused: player.paused() });
  })()`));

  // Whichever item starts playing must be the one the viewer ended on.
  assert.ok(r.plays.every((src) => src.includes('clipB')), `playback only started for clip B (saw ${JSON.stringify(r.plays)})`);
});

// ── runner ───────────────────────────────────────────────────────────────────
function assertDeepEqualCues(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(`${message}\n    expected: ${e}\n    actual:   ${a}`);
}
assert.deepEqualCues = assertDeepEqualCues;

const server = await startFixtureServer({ pkgRoot });
const page = await launchPage();
let failures = 0;
const results = [];

try {
  await page.navigate(server.url + '/harness.html');
  await page.evaluate(PRELUDE);

  for (const { name, fn } of scenarios) {
    if (filter && !name.includes(filter)) continue;
    // Fresh document state for every scenario, so one can't leak into the next.
    await page.navigate(server.url + '/harness.html');
    await page.evaluate(PRELUDE);
    const started = Date.now();
    try {
      await fn(page);
      results.push({ name, ok: true, ms: Date.now() - started });
      console.log(`  PASS  ${name} (${Date.now() - started}ms)`);
    } catch (err) {
      failures++;
      results.push({ name, ok: false, ms: Date.now() - started, error: err.message });
      console.log(`  FAIL  ${name} (${Date.now() - started}ms)`);
      console.log(`        ${String(err.message).split('\n').join('\n        ')}`);
    }
  }

  if (verbose && page.pageErrors.length) {
    console.log('\nBrowser errors observed:');
    for (const e of page.pageErrors) console.log('  - ' + e);
  }
} finally {
  await page.close();
  await server.close();
}

const ran = results.length;
console.log(`\n${ran - failures}/${ran} scenarios passed`);
if (!ran) {
  console.error('No scenarios matched the filter.');
  process.exit(1);
}
process.exit(failures ? 1 : 0);
