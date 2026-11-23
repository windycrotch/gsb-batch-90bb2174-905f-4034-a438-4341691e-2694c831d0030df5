import type Player from 'video.js/dist/types/player';
import type { IKPlayerOptions, RemoteTextTrackOptions, SourceOptions, ShoppableProps } from '../../interfaces';
import type { AugmentedSourceOptions } from '../../interfaces/AugementedSourceOptions';
import { waitForVideoReady, prepareSource, preparePosterSrc } from '../../utils';
import { setTextTracks, validateRemoteTextTrackOptions } from '../subtitles/subtitles';
import { hasPreparedSrc, ensurePrepared } from './source-helpers';
import { SourceSwitchRegistry, type SourceSwitchGuard, type SourceSwitchToken } from './source-switch';

/**
 * Options for creating a source override handler.
 */
export interface SourceOverrideOptions {
  /** ImageKit player options */
  options: IKPlayerOptions;
  /** Callback to get the current source */
  getCurrentSource: () => SourceOptions | null;
  /** Callback to get the original current source */
  getOriginalCurrentSource: () => SourceOptions | null;
  /** Callback to update the current source */
  onSourceUpdate: (source: SourceOptions) => void;
  /** Callback to update the original source */
  onOriginalSourceUpdate: (source: SourceOptions) => void;
  /** Function to check if a source has prepared src */
  hasPreparedSrc: (opts: SourceOptions) => opts is AugmentedSourceOptions;
  /**
   * Optional shared switch registry (owned by the plugin, so it can also be cancelled
   * on dispose). One is created internally when omitted.
   */
  switchRegistry?: SourceSwitchRegistry;
  /**
   * Called synchronously as a new switch begins, before any asynchronous work. UI that
   * belongs to the previous source (thumbnail containers, chapter markers, …) should be
   * torn down here so it can never be mistaken for the incoming source.
   */
  onSwitchStart?: () => void;
  /**
   * Called once the prepared source has actually begun loading (Video.js `loadstart`),
   * with the switch token. Source-dependent UI (chapters, recommendations, shoppable,
   * seek thumbnails) is initialised from here, and must be gated on `token.isCurrent()`.
   */
  onSourceCommitted?: (source: SourceOptions, token: SourceSwitchGuard) => void;
}

// ImageKit ABS (ik-master.m3u8 / ik-master.mpd) renditions are always H.264 High + AAC.
const ABS_STREAM_MIME = 'video/mp4; codecs="avc1.64001f,mp4a.40.2"';

const UNSUPPORTED_ABS_CODEC_MESSAGE =
  'This browser cannot decode H.264 video, which this adaptive (HLS/DASH) stream requires.';

/**
 * Whether the browser has no H.264/AAC decoder for an ImageKit ABS stream. Both MSE and
 * the video element are checked so Safari and pre-17.1 iOS (no MSE) are not flagged.
 */
function cannotDecodeImageKitAbsStream(src: string): boolean {
  if (!/\/ik-master\.(m3u8|mpd)(\?|$)/.test(src)) return false;
  const mediaSource = (window as any).ManagedMediaSource ?? window.MediaSource;
  if (mediaSource?.isTypeSupported?.(ABS_STREAM_MIME)) return false;
  return document.createElement('video').canPlayType(ABS_STREAM_MIME) === '';
}

function showLoadingState(player: Player): void {
  const bigPlay = player.getChild('BigPlayButton');
  bigPlay && bigPlay.hide();
  const spinner = player.getChild('LoadingSpinner');
  player.addClass('vjs-waiting');
  spinner?.el()?.setAttribute('aria-hidden', 'false');
}

function hideLoadingState(player: Player): void {
  const bigPlay = player.getChild('BigPlayButton');
  bigPlay && bigPlay.show();
  player.removeClass('vjs-waiting');
  const spinner = player.getChild('LoadingSpinner');
  spinner?.el()?.setAttribute('aria-hidden', 'true');
}

function validateSourceOptions(source: SourceOptions): void {
  if (!source.src || typeof source.src !== 'string') {
    throw new Error('`src` is required and must be a non-empty string.');
  }

  if (source.textTracks) {
    if (!Array.isArray(source.textTracks)) {
      throw new Error('`textTracks` must be an array.');
    }
    source.textTracks.forEach((track, index) => {
      try {
        validateRemoteTextTrackOptions(track);
      } catch (err) {
        throw new Error(`\`textTracks[${index}]\`: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  if (source.recommendations) {
    if (!Array.isArray(source.recommendations)) {
      throw new Error('`recommendations` must be an array.');
    }
    source.recommendations.forEach((rec, index) => {
      try {
        validateSourceOptions(rec);
      } catch (err) {
        throw new Error(`\`recommendations[${index}]\`: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  if (source.shoppable) {
    const shoppable = source.shoppable as ShoppableProps;
    if (!Array.isArray(shoppable.products)) {
      throw new Error('`shoppable.products` is required and must be an array.');
    }
    if (shoppable.products.length === 0) {
      throw new Error('`shoppable.products` must contain at least one product.');
    }
    if (shoppable.autoClose !== undefined && shoppable.autoClose !== false && (typeof shoppable.autoClose !== 'number' || shoppable.autoClose < 0)) {
      throw new Error('`shoppable.autoClose` must be a non-negative number or false.');
    }
    if (shoppable.startState && !['closed', 'open', 'openOnPlay'].includes(shoppable.startState)) {
      throw new Error("`shoppable.startState` must be 'closed', 'open', or 'openOnPlay'.");
    }
    if (shoppable.width !== undefined && (typeof shoppable.width !== 'number' || shoppable.width < 0 || shoppable.width > 100)) {
      throw new Error('`shoppable.width` must be a number between 0 and 100.');
    }
    shoppable.products.forEach((product, index) => {
      if (typeof product.productId !== 'number') {
        throw new Error(`\`shoppable.products[${index}].productId\` is required and must be a number.`);
      }
      if (!product.productName || typeof product.productName !== 'string') {
        throw new Error(`\`shoppable.products[${index}].productName\` is required and must be a non-empty string.`);
      }
      if (!product.imageUrl || typeof product.imageUrl !== 'string') {
        throw new Error(`\`shoppable.products[${index}].imageUrl\` is required and must be a non-empty string.`);
      }
    });
  }
}

async function prepareSourceIfNeeded(
  source: SourceOptions,
  options: IKPlayerOptions
): Promise<SourceOptions> {
  if (hasPreparedSrc(source)) {
    return source;
  }
  return prepareSource(source, options);
}

/**
 * Sets up text tracks (subtitles/captions) for the player from the current source.
 * All work is gated on the switch token inside `setTextTracks`.
 */
function setupTextTracks(
  player: Player,
  source: SourceOptions,
  options: IKPlayerOptions,
  token: SourceSwitchGuard
): void {
  const textTracks = source.textTracks || [];
  if (textTracks.length) {
    setTextTracks(player, textTracks as RemoteTextTrackOptions[], source, options.signerFn, token);
  }
}

/**
 * Sets up the poster image for the player from the current source.
 */
function setupPoster(
  player: Player,
  source: SourceOptions,
  options: IKPlayerOptions,
  token: SourceSwitchGuard
): void {
  const preparedPoster = (source as AugmentedSourceOptions | null | undefined)?.prepared?.poster;

  if (preparedPoster) {
    if (token.isCurrent()) player.poster(preparedPoster);
    return;
  }

  preparePosterSrc(source, options).then(
    poster => {
      // A later switch owns the UI now; its poster must not be overwritten by ours.
      if (!token.isCurrent()) return;
      if (poster) {
        player.poster(poster);
      }
      ensurePrepared(source as AugmentedSourceOptions).poster = poster ?? undefined;
    }
  ).catch(err => {
    if (!token.isCurrent()) return;
    player.log.error(`Failed to load poster: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Creates a source override function that replaces Video.js's native src method.
 * This handles ImageKit source preparation, validation, and setup.
 *
 * Every call starts a new switch lifecycle. A switch owns the player UI only while it
 * is the latest one; once superseded, all of its late asynchronous continuations
 * (success and failure) are dropped instead of mutating the player.
 *
 * @param player - The Video.js player instance
 * @param overrideOptions - Options for the source override
 * @returns A function that can be assigned to player.src
 */
export function createSourceOverride(
  player: Player,
  overrideOptions: SourceOverrideOptions
): any {
  const { options, getCurrentSource, getOriginalCurrentSource, onSourceUpdate, onOriginalSourceUpdate, hasPreparedSrc } = overrideOptions;
  const nativeSrc = player.src.bind(player);
  // options({}) returns the merged player options; video.js's typings require an argument.
  const defaultNotSupportedMessage = player.options({}).notSupportedMessage;
  const switchRegistry = overrideOptions.switchRegistry ?? new SourceSwitchRegistry();

  // The switch whose `nativeSrc` call the next `loadstart` belongs to. Because only
  // the current switch ever calls `nativeSrc`, a `loadstart` from a stale tech load
  // cannot be mistaken for the current switch's.
  let pendingCommitToken: SourceSwitchToken | null = null;

  const waitForCommittedLoad = (token: SourceSwitchToken, source: SourceOptions) => {
    pendingCommitToken = token;
    const onLoadStart = () => {
      if (pendingCommitToken !== token) return;
      pendingCommitToken = null;
      player.off('loadstart', onLoadStart);
      if (!token.isCurrent()) return;
      try {
        overrideOptions.onSourceCommitted?.(source, token);
      } catch (err) {
        // Committing the media source is this switch's job; a failure in the
        // source-scoped UI initialiser must not break Video.js's own dispatch.
        player.log.error(`Failed to initialise source UI: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    // If this switch is superseded before the source ever starts loading, stop waiting.
    token.onSupersede(() => {
      player.off('loadstart', onLoadStart);
      if (pendingCommitToken === token) pendingCommitToken = null;
    });
    player.on('loadstart', onLoadStart);
  };

  return (source?: SourceOptions) => {
    if (source === undefined) {
      return getOriginalCurrentSource();
    }

    // Invalid input never starts a switch, so the source already playing is untouched.
    validateSourceOptions(source);

    // Clone the source immediately after validation to prevent mutating the original
    const sourceClone = { ...source };
    onOriginalSourceUpdate({ ...sourceClone });
    onSourceUpdate({ ...sourceClone });

    const token = switchRegistry.begin();

    // Tear down UI owned by the superseded source right away, before any waiting.
    overrideOptions.onSwitchStart?.();

    // The previous source's poster must not stay on screen as if it belonged to the
    // incoming video. The new poster is set once this switch's poster is ready.
    player.poster('');

    const currentSource = getCurrentSource();
    if (!currentSource) {
      // Nothing to load; never leave the spinner up for a switch that cannot finish.
      hideLoadingState(player);
      return;
    }

    // A new switch replaces the previous load, including its error state, immediately.
    // (`Player.error` accepts null to clear it, but its typings omit that overload.)
    (player as any).error(null);
    showLoadingState(player);

    prepareSourceIfNeeded(currentSource, options)
      .then(async (prepared: SourceOptions) => {
        if (!token.isCurrent()) {
          return;
        }

        const { maxTries, videoTimeoutInMS, delayInMS } = options;

        if (!hasPreparedSrc(currentSource)) {
          ensurePrepared(currentSource as AugmentedSourceOptions).src = prepared.src;
        }

        onSourceUpdate(prepared);

        await waitForVideoReady(
          prepared.src,
          maxTries!,
          videoTimeoutInMS!,
          delayInMS,
          token.signal
        );

        if (!token.isCurrent()) {
          return;
        }

        // video.js raises its "no compatible source" error (code 4) with `notSupportedMessage`;
        // name the missing decoder instead when that is the cause.
        player.options({
          notSupportedMessage: cannotDecodeImageKitAbsStream(prepared.src)
            ? UNSUPPORTED_ABS_CODEC_MESSAGE
            : defaultNotSupportedMessage,
        });

        waitForCommittedLoad(token, prepared);
        nativeSrc(prepared as any);

        if (!token.isCurrent()) {
          return;
        }

        setupTextTracks(player, prepared, options, token);
        setupPoster(player, prepared, options, token);
      })
      .catch(err => {
        // A superseded switch must never raise an error over the new video.
        if (token.isCurrent()) {
          player.error(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        // Loading settles on success, failure and supersession (the superseding switch
        // takes ownership of the indicator and will settle it itself).
        if (token.isCurrent()) {
          hideLoadingState(player);
        }
      });
  };
}
