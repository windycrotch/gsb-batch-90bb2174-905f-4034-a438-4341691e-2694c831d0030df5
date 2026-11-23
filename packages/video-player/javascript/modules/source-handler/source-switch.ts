/**
 * A single source switch (one call to `player.src(...)`).
 *
 * A switch is a complete lifecycle: it can be superseded by a newer switch at any
 * point. Every asynchronous step that ends up touching the player (video source,
 * text tracks, poster, chapters, seek thumbnails, recommendations, shoppable UI,
 * loading indicator, error state) checks its token right before it mutates the UI.
 * Once `isCurrent()` is false, late successes and failures from that switch are
 * dropped instead of landing on the newer video.
 *
 * Tokens also carry an `AbortSignal` so in-flight network requests belonging to a
 * superseded switch can be cancelled, and an `onSupersede` hook so UI that the
 * switch already created (extra text tracks, thumbnail containers, chapter markers)
 * is torn down when the next switch begins.
 */
export interface SourceSwitchGuard {
  /** Monotonic id; newer switches have larger ids. */
  readonly id: number;
  /** True while this is the most recently begun switch. */
  isCurrent(): boolean;
  /**
   * Runs `cleanup` when this switch is superseded (immediately if it already was).
   * `offSupersede` unregisters a cleanup that is no longer needed (e.g. a one-shot wait
   * that already resolved).
   */
  onSupersede(cleanup: () => void): void;
  offSupersede(cleanup: () => void): void;
}

export interface SourceSwitchToken extends SourceSwitchGuard {
  /** Aborted as soon as a newer switch begins (or the player is disposed). */
  readonly signal?: AbortSignal;
}

interface SwitchEntry {
  id: number;
  controller: AbortController | null;
  cleanups: Array<() => void>;
}

function runCleanup(cleanup: () => void): void {
  try {
    cleanup();
  } catch (err) {
    // Cleanup must never break the switch that superseded this one.
    if (typeof console !== 'undefined') {
      console.error('[imagekit-video-player] source switch cleanup failed', err);
    }
  }
}

/**
 * Creates and tracks source switch tokens for one player.
 */
export class SourceSwitchRegistry {
  private sequence_ = 0;
  private current_: SwitchEntry | null = null;

  /** The switch that currently owns the player UI, if any. */
  current(): SourceSwitchToken | null {
    return this.current_ ? this.toToken_(this.current_) : null;
  }

  /**
   * Starts a new switch: aborts and tears down the previous one, then returns its token.
   */
  begin(): SourceSwitchToken {
    const previous = this.current_;
    this.current_ = null;
    if (previous) {
      try {
        previous.controller?.abort();
      } catch {
        // An abort listener throwing must not block the new switch.
      }
      previous.cleanups.splice(0, previous.cleanups.length).forEach(runCleanup);
    }

    const entry: SwitchEntry = {
      id: ++this.sequence_,
      controller: typeof AbortController !== 'undefined' ? new AbortController() : null,
      cleanups: [],
    };
    this.current_ = entry;
    return this.toToken_(entry);
  }

  /**
   * Stops tracking the current switch (on player dispose), aborting its requests and
   * running its cleanups. Later callbacks from it see `isCurrent() === false`.
   */
  cancel(): void {
    const current = this.current_;
    this.current_ = null;
    if (!current) return;
    try {
      current.controller?.abort();
    } catch {
      // ignore
    }
    current.cleanups.splice(0, current.cleanups.length).forEach(runCleanup);
  }

  private toToken_(entry: SwitchEntry): SourceSwitchToken {
    return {
      id: entry.id,
      signal: entry.controller?.signal,
      isCurrent: () => this.current_ === entry,
      onSupersede: (cleanup: () => void) => {
        if (this.current_ === entry) {
          entry.cleanups.push(cleanup);
        } else {
          runCleanup(cleanup);
        }
      },
      offSupersede: (cleanup: () => void) => {
        const index = entry.cleanups.indexOf(cleanup);
        if (index !== -1) entry.cleanups.splice(index, 1);
      },
    };
  }
}
