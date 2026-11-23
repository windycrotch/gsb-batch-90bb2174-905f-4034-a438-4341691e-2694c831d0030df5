/**
 * In-page driver for the source-switch harness.
 *
 * Provides:
 *  - a controllable network layer: requests are delayed / failed by URL rule, so the
 *    tests can make an "old" source slow (or failing) and a "new" one fast;
 *  - 'createPlayer', 'load' and 'waitFor' helpers;
 *  - 'visibleState()', which reads only what a viewer could see in the player UI
 *    (poster, cue text, spinner, error, chapters, up-next, recommendations,
 *    shoppable) — never logs or private fields.
 */
export const DRIVER_JS = String.raw`
(function () {
  'use strict';

  const realFetch = window.fetch.bind(window);

  // url pattern -> { delay?: ms, fail?: boolean, body?: string, status?: number }
  const rules = [];
  const requestLog = [];

  function matchRule(url) {
    for (const rule of rules) {
      if (rule.match.test(url)) return rule;
    }
    return null;
  }

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    const rule = matchRule(url);
    requestLog.push({ url, rule: rule ? rule.name || '(rule)' : null, at: Date.now() });
    if (!rule) return realFetch(input, init);
    // Only delay/fail the *response*. The request is still issued immediately, so
    // in-flight refinement of the rules after this call does not affect it.
    const snapshot = { delay: rule.delay ?? 0, fail: !!rule.fail, body: rule.body, status: rule.status, contentType: rule.contentType };
    const run = () => {
      if (snapshot.fail) {
        return Promise.reject(new TypeError('Failed to fetch (simulated)'));
      }
      if (snapshot.body != null) {
        return Promise.resolve(new Response(snapshot.body, {
          status: snapshot.status ?? 200,
          headers: { 'Content-Type': snapshot.contentType || 'text/plain' },
        }));
      }
      return realFetch(input, init);
    };
    if (!snapshot.delay) return run();
    return new Promise((resolve, reject) => {
      setTimeout(() => { run().then(resolve, reject); }, snapshot.delay);
    });
  };

  // <img> loads (posters) bypass fetch; route them through a delay when a rule matches.
  const realImageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  const delayedSrcs = new Map();
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    get() { return realImageSrc.get.call(this); },
    set(value) {
      const rule = matchRule(String(value));
      if (rule && rule.delay) {
        delayedSrcs.set(value, true);
        setTimeout(() => { realImageSrc.set.call(this, value); }, rule.delay);
        return;
      }
      realImageSrc.set.call(this, value);
    },
  });

  const fixture = {
    rules, requestLog,

    /** URL rules applied to the controllable signerFn (see createPlayer). */
    signerRules: [],
    signerLog: [],

    setRules(next) {
      rules.length = 0;
      for (const r of next) rules.push({ ...r, match: new RegExp(r.pattern) });
    },

    clearRules() { rules.length = 0; },

    setSignerRules(next) {
      fixture.signerRules = next.map((r) => ({ ...r, match: new RegExp(r.pattern) }));
    },

    clearSignerRules() { fixture.signerRules = []; },

    /**
     * Controllable signer. The ImageKit switch awaits the signer before loading
     * anything, so a rule here lets the test make an entire switch slow, or fail.
     */
    makeSigner() {
      return (url) => {
        fixture.signerLog.push({ url, at: Date.now() });
        const rule = fixture.signerRules.find((r) => r.match.test(url));
        const delay = rule ? (rule.delay ?? 0) : 0;
        const finish = () => {
          if (rule && rule.fail) throw new Error('signing failed (simulated) for ' + url);
          return url;
        };
        if (!delay) return Promise.resolve().then(finish);
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            try { resolve(finish()); } catch (e) { reject(e); }
          }, delay);
        });
      };
    },

    createPlayer(overrides) {
      if (window.__player) {
        try { window.__player.dispose(); } catch (e) {}
        window.__player = null;
      }
      const el = document.createElement('video');
      el.id = 'player';
      el.className = 'video-js';
      el.setAttribute('controls', '');
      el.setAttribute('preload', 'auto');
      const host = document.querySelector('.stack');
      host.innerHTML = '';
      host.appendChild(el);
      const player = window.ImageKitVideoPlayer.videoPlayer(el, {
        imagekitId: 'harness',
        seekThumbnails: true,
        maxTries: 1,
        videoTimeoutInMS: 4000,
        signerFn: fixture.makeSigner(),
        ...(overrides || {}),
      }, { muted: true, autoplay: false });
      // Keep the player strictly harness-sized; playlist layouts are out of scope here.
      player.width(640); player.height(360);
      window.__player = player;
      return player;
    },

    player() { return window.__player; },

    /** Absolute URL for a fixture path (ImageKit source handling requires absolute URLs). */
    url(p) { return new URL(p, location.origin).toString(); },

    /** Builds an absolute-URL source object from fixture-relative paths. */
    source(s) {
      const abs = (u) => (typeof u === 'string' ? new URL(u, location.origin).toString() : u);
      const out = { ...s, src: abs(s.src) };
      if (s.poster && s.poster.src) out.poster = { ...s.poster, src: abs(s.poster.src) };
      if (s.chapters && typeof s.chapters === 'object' && s.chapters.url) {
        out.chapters = { ...s.chapters, url: abs(s.chapters.url) };
      }
      if (s.textTracks) {
        out.textTracks = s.textTracks.map((t) => (t && t.src ? { ...t, src: abs(t.src) } : t));
      }
      if (s.recommendations) out.recommendations = s.recommendations.map((r) => this.source(r));
      return out;
    },

    load(source) { window.__player.src(this.source(source)); },

    waitFor(predicate, timeoutMs = 15000, label = 'condition') {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
          let value;
          try { value = predicate(); } catch (e) { return reject(e); }
          if (value) return resolve(value);
          if (Date.now() - started > timeoutMs) {
            return reject(new Error('Timed out waiting for ' + label));
          }
          setTimeout(tick, 25);
        };
        tick();
      });
    },

    sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },

    /** What the viewer can actually see right now. No logs, no private fields. */
    visibleState() {
      const player = window.__player;
      const playerEl = player && player.el();
      const spinnerEl = playerEl && playerEl.querySelector('.vjs-loading-spinner');
      const posterImg = playerEl && playerEl.querySelector('.vjs-poster img');
      const cues = playerEl ? [...playerEl.querySelectorAll('.vjs-text-track-cue')] : [];
      const errorEl = playerEl && playerEl.querySelector('.vjs-error-display');
      const errorVisible = !!(playerEl && playerEl.classList.contains('vjs-error')) &&
        !!errorEl && !errorEl.classList.contains('vjs-hidden');
      const chapterDisplay = playerEl && playerEl.querySelector('.vjs-control-bar-chapter-display');
      const upNext = playerEl && playerEl.querySelector('.vjs-up-next-overlay:not(.vjs-hidden) .vjs-up-next-overlay-title');
      const upcoming = playerEl && playerEl.querySelector('.vjs-present-upcoming:not(.vjs-hidden) .vjs-up-next-title');
      const recTitles = playerEl
        ? [...playerEl.querySelectorAll('.vjs-recommendations-overlay .vjs-rec-title')].map((e) => e.textContent.trim())
        : [];
      const recVisible = !!(playerEl && playerEl.querySelector('.vjs-recommendations-overlay:not(.vjs-hidden)'));
      return {
        poster: posterImg ? posterImg.getAttribute('src') : null,
        posterVisible: !!(playerEl && playerEl.classList.contains('vjs-has-started') === false && posterImg),
        cues: cues.map((c) => c.textContent.trim()).filter(Boolean),
        cueLanguages: cues.map((c) => c.getAttribute('lang')).filter(Boolean),
        spinnerVisible: !!spinnerEl && getComputedStyle(spinnerEl).display !== 'none',
        waitingClass: !!(playerEl && playerEl.classList.contains('vjs-waiting')),
        errorVisible,
        errorText: errorVisible && errorEl ? (errorEl.textContent || '').trim() : '',
        chapterLabels: playerEl
          ? [...playerEl.querySelectorAll('.vjs-chapter-boundary')].length
          : 0,
        chapterTooltip: chapterDisplay ? (chapterDisplay.textContent || '').trim() : '',
        upNextVisible: !!upNext,
        upNextTitle: upNext ? upNext.textContent.trim() : null,
        upcomingVisible: !!upcoming,
        upcomingTitle: upcoming ? upcoming.textContent.trim() : null,
        recVisible,
        recTitles,
        shoppableProducts: playerEl
          ? [...playerEl.querySelectorAll('.vjs-shoppable-item-info')].map((e) => e.textContent.trim())
          : [],
        /** Media actually attached to the element (an absolute URL), i.e. what plays. */
        currentSrc: player ? (player.currentSrc() || '') : '',
        /** Poster the player currently owns (empty string once cleared for a new switch). */
        posterSrc: player ? player.poster() : '',
        /** Chapter labels currently in the player's chapter text track (shown in the UI). */
        chapterCues: (function () {
          if (!player) return [];
          const out = [];
          const tracks = player.textTracks();
          for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            if (track.kind !== 'chapters') continue;
            const cues = track.cues;
            if (!cues) continue;
            for (let j = 0; j < cues.length; j++) out.push(String(cues[j].text || ''));
          }
          return out.filter(Boolean);
        })(),
        /** Subtitle text of every subtitle/caption track the player knows about. */
        subtitleTrackText: (function () {
          if (!player) return [];
          const out = [];
          const tracks = player.textTracks();
          for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            if (track.kind !== 'subtitles' && track.kind !== 'captions') continue;
            const cues = track.cues;
            if (!cues) continue;
            for (let j = 0; j < cues.length; j++) out.push(String(cues[j].text || ''));
          }
          return out.filter(Boolean);
        })(),
      };
    },

    /** Seek the progress bar so the current chapter label is filled in. */
    seek(seconds) {
      const player = window.__player;
      try { player.currentTime(seconds); } catch (e) {}
    },

    /**
     * Moves the mouse over the progress bar, which is what makes the seek-thumbnail
     * tooltip visible. Returns whether a thumbnail image is on screen afterwards.
     */
    async hoverProgressBar() {
      const player = window.__player;
      const progress = player.controlBar.progressControl.el();
      const rect = progress.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      for (const type of ['mousemove', 'pointermove']) {
        progress.dispatchEvent(new MouseEvent(type, {
          bubbles: true, clientX: x, clientY: y,
        }));
      }
      await fixture.sleep(120);
      const container = player.el().querySelector('.thumbnail-preview');
      if (!container) return null;
      const thumb = container.querySelector('.thumbnail');
      return {
        visible: getComputedStyle(container).display !== 'none',
        backgroundImage: thumb ? getComputedStyle(thumb).backgroundImage : null,
      };
    },
  };

  window.__fixture = fixture;
})();
`;
