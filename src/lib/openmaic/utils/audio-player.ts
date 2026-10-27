/**
 * Audio Player - Audio player interface
 *
 * Handles audio playback, pause, stop, and other operations
 * Loads pre-generated TTS audio files from IndexedDB
 *
 */

import { db } from '@openmaic/lib/utils/database';
import { createLogger } from '@openmaic/lib/logger';
import { hasWavHeader, normalizePlayableWav } from '@openmaic/lib/audio/wav-container';

const log = createLogger('AudioPlayer');
const PLAYBACK_WARMUP_MS = 650;
const PLAYBACK_WARMUP_VOLUME = 0.001;
const PLAYBACK_REWIND_TIMEOUT_MS = 1_000;
const PLAYBACK_REWIND_EPSILON_SECONDS = 0.01;
const MEDIA_WAIT_TIMEOUT_MS = 15_000;

function isWavAudio(blob: Blob, format?: string): boolean {
  const lowerFormat = format?.toLowerCase();
  return lowerFormat === 'wav' || blob.type.includes('audio/wav') || blob.type.includes('audio/x-wav');
}

async function normalizeAudioBlob(blob: Blob, format?: string): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!isWavAudio(blob, format) && !hasWavHeader(bytes)) return blob;
  const normalized = normalizePlayableWav(bytes);
  const normalizedBuffer = normalized.buffer.slice(
    normalized.byteOffset,
    normalized.byteOffset + normalized.byteLength,
  ) as ArrayBuffer;
  return new Blob([normalizedBuffer], { type: 'audio/wav' });
}

async function describeAudioBlob(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const signature = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ');
  return `type=${blob.type || 'unknown'}, size=${blob.size}, signature=${signature}`;
}

/**
 * Audio player implementation
 */
export class AudioPlayer {
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private onEndedCallback: (() => void) | null = null;
  private muted: boolean = false;
  private volume: number = 1;
  private playbackRate: number = 1;
  private warmupNextPlayback: boolean = true;
  private warmupAudio: HTMLAudioElement | null = null;
  private playbackVersion = 0;
  private playbackPaused = false;
  private pendingAudio: HTMLAudioElement | null = null;
  private pendingPlaybackVersion: number | null = null;
  private wakePendingStart: (() => void) | null = null;
  private cancelMediaStart: (() => void) | null = null;
  private pendingDownload: AbortController | null = null;
  private stopMonitoring: (() => void) | null = null;
  private onErrorCallback: ((error: Error) => void) | null = null;
  private prefetchedAudio: { url: string; audio: HTMLAudioElement } | null = null;
  private stopPrefetchWatch: (() => void) | null = null;

  /**
   * Play audio (from URL or IndexedDB pre-generated cache)
   * @param audioId Audio ID
   * @param audioUrl Optional server-generated audio URL (takes priority over IndexedDB)
   * @returns true if audio started playing, false if no audio (TTS disabled or not generated)
   */
  public async play(
    audioId: string,
    audioUrl?: string,
    startRatio: number = 0,
  ): Promise<boolean> {
    const playbackVersion = ++this.playbackVersion;
    this.playbackPaused = false;
    this.pendingPlaybackVersion = playbackVersion;
    try {
      // Reuse the element itself, including its partially buffered response.
      // Reassigning src or opening another Audio would discard that head start.
      const prefetched = this.prefetchedAudio && this.prefetchedAudio.url === audioUrl
        ? this.prefetchedAudio.audio : null;
      if (prefetched) {
        this.stopPrefetchWatch?.();
        this.stopPrefetchWatch = null;
        this.prefetchedAudio = null;
      }
      this.clearCurrentAudio();
      // 1. Try audioUrl first (server-generated TTS)
      if (audioUrl) {
        const audio = prefetched ?? new Audio();
        this.audio = audio;
        if (!prefetched) audio.src = audioUrl;
        if (this.muted) audio.volume = 0;
        else audio.volume = this.volume;
        audio.defaultPlaybackRate = this.playbackRate;
        audio.playbackRate = this.playbackRate;
        audio.addEventListener('ended', () => {
          if (this.warmupAudio === audio || this.audio !== audio) return;
          this.onEndedCallback?.();
        });
        try {
          return await this.startPlayback(audio, startRatio);
        } catch (playError) {
          if (this.playbackVersion !== playbackVersion || this.audio !== audio) return false;
          this.clearCurrentAudio();
          // Autoplay denial requires another user gesture, not a duplicate
          // download (which would lose the gesture again on some browsers).
          if (typeof playError === 'object' && playError !== null
            && 'name' in playError && playError.name === 'NotAllowedError') {
            throw new Error('浏览器尚未允许播放声音，请点击播放按钮重试');
          }
          const sourceBlob = await this.downloadAudio(audioUrl);
          const normalizedBlob = await normalizeAudioBlob(sourceBlob, audioUrl.split('.').pop());
          if (this.playbackVersion !== playbackVersion) return false;
          const blobUrl = URL.createObjectURL(normalizedBlob);
          this.objectUrl = blobUrl;
          const fallbackAudio = new Audio();
          this.audio = fallbackAudio;
          fallbackAudio.src = blobUrl;
          if (this.muted) fallbackAudio.volume = 0;
          else fallbackAudio.volume = this.volume;
          fallbackAudio.defaultPlaybackRate = this.playbackRate;
          fallbackAudio.playbackRate = this.playbackRate;
          fallbackAudio.addEventListener('ended', () => {
            if (this.warmupAudio === fallbackAudio || this.audio !== fallbackAudio) return;
            this.revokeObjectUrl();
            this.onEndedCallback?.();
          });
          try {
            return await this.startPlayback(fallbackAudio, startRatio);
          } catch (retryError) {
            if (this.playbackVersion !== playbackVersion || this.audio !== fallbackAudio) return false;
            this.clearCurrentAudio();
            log.error(
              `Retry failed for audioUrl=${audioUrl}; ${await describeAudioBlob(normalizedBlob)}`,
              retryError,
            );
            throw retryError;
          }
        }
      }

      // 2. Fall back to IndexedDB (client-generated TTS)
      const audioRecord = await db.audioFiles.get(audioId);
      if (this.playbackVersion !== playbackVersion) return false;

      if (!audioRecord) {
        // Pre-generated audio does not exist (generation failed), skip silently
        return false;
      }

      // Set audio source
      const playableBlob = await normalizeAudioBlob(audioRecord.blob, audioRecord.format);
      if (this.playbackVersion !== playbackVersion) return false;
      const blobUrl = URL.createObjectURL(playableBlob);
      this.objectUrl = blobUrl;
      const audio = new Audio();
      this.audio = audio;
      audio.src = blobUrl;
      if (this.muted) audio.volume = 0;
      else audio.volume = this.volume;

      // Apply playback rate
      audio.defaultPlaybackRate = this.playbackRate;
      audio.playbackRate = this.playbackRate;

      // Set ended callback
      audio.addEventListener('ended', () => {
        if (this.warmupAudio === audio || this.audio !== audio) return;
        this.revokeObjectUrl();
        this.onEndedCallback?.();
      });
      // Play. If play() rejects (autoplay policy, decode error, interrupted
      // load) the 'ended' listener never fires, so revoke the blob URL here to
      // avoid leaking it for the lifetime of the document.
      try {
        return await this.startPlayback(audio, startRatio);
      } catch (playError) {
        if (this.playbackVersion !== playbackVersion || this.audio !== audio) return false;
        this.clearCurrentAudio();
        log.error(
          `IndexedDB audio failed for audioId=${audioId}; format=${audioRecord.format}; ${await describeAudioBlob(
            playableBlob,
          )}`,
          playError,
        );
        throw playError;
      }
    } catch (error) {
      if (this.playbackVersion !== playbackVersion) return false;
      log.error('Failed to play audio:', error);
      throw error;
    } finally {
      if (this.pendingPlaybackVersion === playbackVersion) this.pendingPlaybackVersion = null;
    }
  }

  /**
   * Pause playback
   */
  public pause(): void {
    this.playbackPaused = true;
    this.cancelPrefetch();
    if (!this.audio) return;
    if (!this.audio.paused) this.audio.pause();
    // Keep the preroll pending until its rewind completes. Clearing it here
    // lets a quick Resume start audibly from the still-seeking quiet prefix.
  }

  /**
   * Stop playback
   */
  public stop(): void {
    this.playbackVersion++;
    this.pendingPlaybackVersion = null;
    this.clearCurrentAudio();
  }

  private clearCurrentAudio(): void {
    this.cancelPrefetch();
    this.cancelMediaStart?.();
    this.pendingDownload?.abort();
    this.pendingDownload = null;
    this.stopMonitoring?.();
    this.stopMonitoring = null;
    if (this.audio) {
      this.audio.pause();
      // Pausing alone leaves the browser downloading an abandoned clip.
      this.audio.removeAttribute('src');
      this.audio.load();
      if (this.warmupAudio === this.audio) this.warmupAudio = null;
      this.audio = null;
    }
    this.releasePendingStart();
    this.revokeObjectUrl();
    // Note: onEndedCallback intentionally NOT cleared here because play()
    // calls stop() internally — clearing would break the callback chain.
    // Stale callbacks are harmless: engine mode check prevents processNext().
  }

  /**
   * Resume playback
   */
  public resume(): void {
    this.playbackPaused = false;
    this.releasePendingStart();
    if (this.pendingAudio === this.audio) return;
    if (this.audio?.paused && !this.audio.ended) {
      this.audio.playbackRate = this.playbackRate;
      const audio = this.audio;
      this.playWhenReady(audio).catch((error: unknown) => {
        if (this.audio !== audio) return;
        this.failActiveAudio(error instanceof Error ? error : new Error('语音恢复失败，请点击播放重试'));
      });
    }
  }

  /**
   * Get current playback status (actively playing, not paused)
   */
  public isPlaying(): boolean {
    return this.audio !== null && !this.audio.paused;
  }

  /**
   * Whether there is active audio (playing or paused, but not ended)
   * Used to decide whether to resume playback or skip to the next line
   */
  public hasActiveAudio(): boolean {
    return this.pendingPlaybackVersion === this.playbackVersion
      || this.audio !== null && !this.audio.ended;
  }

  /**
   * Get current playback time (milliseconds)
   */
  public getCurrentTime(): number {
    return this.audio && this.warmupAudio !== this.audio ? this.audio.currentTime * 1000 : 0;
  }

  /**
   * Get audio duration (milliseconds)
   */
  public getDuration(): number {
    return this.audio && !isNaN(this.audio.duration) ? this.audio.duration * 1000 : 0;
  }

  /**
   * Set playback ended callback
   */
  public onEnded(callback: () => void): void {
    this.onEndedCallback = callback;
  }

  /** Media can fail after play() has already resolved. */
  public onError(callback: (error: Error) => void): void {
    this.onErrorCallback = callback;
  }

  /**
   * Prepare only the next narration after the current clip is fully buffered.
   * This never blocks playback or fetches the rest of the course. The browser
   * can stream the same element immediately even if its preload is incomplete.
   */
  public preloadNext(audioUrl?: string): void {
    this.cancelPrefetch();
    const current = this.audio;
    const connection = (navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }).connection;
    if (!audioUrl || !current || this.playbackPaused || document.hidden
      || connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? '')) return;

    const cancel = () => this.cancelPrefetch();
    const onVisibility = () => { if (document.hidden) cancel(); };
    const onPause = () => { if (!current.ended) cancel(); };
    const prepare = () => {
      if (this.prefetchedAudio || this.audio !== current || current.paused || current.ended) return;
      if (!Number.isFinite(current.duration) || current.duration <= 0) return;
      // canplaythrough is only an estimate. Inspect the actual buffered ranges
      // so a shared classroom connection serves the current narration first.
      const ranges = current.buffered;
      let complete = false;
      for (let i = 0; i < ranges.length; i++) {
        if (ranges.start(i) <= current.currentTime && ranges.end(i) >= current.duration - 0.05) {
          complete = true;
          break;
        }
      }
      if (!complete) return;
      const next = new Audio();
      this.prefetchedAudio = { url: audioUrl, audio: next };
      next.preload = 'auto';
      next.addEventListener('error', cancel, { once: true });
      next.src = audioUrl;
      next.load();
    };
    current.addEventListener('progress', prepare);
    current.addEventListener('canplaythrough', prepare);
    current.addEventListener('waiting', cancel);
    current.addEventListener('stalled', cancel);
    current.addEventListener('pause', onPause);
    document.addEventListener('visibilitychange', onVisibility);
    this.stopPrefetchWatch = () => {
      current.removeEventListener('progress', prepare);
      current.removeEventListener('canplaythrough', prepare);
      current.removeEventListener('waiting', cancel);
      current.removeEventListener('stalled', cancel);
      current.removeEventListener('pause', onPause);
      document.removeEventListener('visibilitychange', onVisibility);
      this.prefetchedAudio?.audio.removeEventListener('error', cancel);
    };
    prepare();
  }

  private cancelPrefetch(): void {
    this.stopPrefetchWatch?.();
    this.stopPrefetchWatch = null;
    const next = this.prefetchedAudio?.audio;
    this.prefetchedAudio = null;
    if (!next) return;
    next.pause();
    next.removeAttribute('src');
    next.load();
  }

  /**
   * Warm the media output before the next clip starts audibly. Laptop and
   * Bluetooth sinks can take a few hundred milliseconds to wake after a page
   * change; without a pre-roll that startup latency clips the first words.
   */
  public requestPlaybackWarmup(): void {
    this.warmupNextPlayback = true;
  }

  /**
   * Set mute state (takes effect immediately on currently playing audio)
   */
  public setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyVolume();
  }

  /**
   * Set volume (0-1)
   */
  public setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.applyVolume();
  }

  private applyVolume(): void {
    if (!this.audio) return;
    this.audio.volume = this.muted
      ? 0
      : this.warmupAudio === this.audio
        ? Math.min(this.volume, PLAYBACK_WARMUP_VOLUME)
        : this.volume;
  }

  /**
   * Set playback speed (takes effect immediately on currently playing audio)
   */
  public setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.5, Math.min(2, rate));
    if (this.audio) {
      this.audio.playbackRate = this.playbackRate;
    }
  }

  /**
   * Destroy the player
   */
  public destroy(): void {
    this.stop();
    this.onEndedCallback = null;
    this.onErrorCallback = null;
  }

  private revokeObjectUrl(): void {
    if (!this.objectUrl) return;
    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  private async startPlayback(audio: HTMLAudioElement, startRatio: number): Promise<boolean> {
    this.pendingAudio = audio;
    try {
      await this.seekToRatioWhenReady(audio, startRatio);
      while (this.audio === audio && this.playbackPaused) await this.waitForResume();
      if (this.audio !== audio) return false;
      const prepared = await this.warmupIfNeeded(audio, startRatio);
      while (this.audio === audio && this.playbackPaused) await this.waitForResume();
      if (!prepared || this.audio !== audio) return false;
      await this.playWhenReady(audio);
      if (this.audio === audio) this.monitorPlayback(audio);
      return this.audio === audio;
    } finally {
      if (this.pendingAudio === audio) this.pendingAudio = null;
    }
  }

  private releasePendingStart(): void {
    const wake = this.wakePendingStart;
    this.wakePendingStart = null;
    wake?.();
  }

  private waitForResume(): Promise<void> {
    // Keep the original startup (including its retry/error handling) pending.
    // A direct play() on Resume could bypass a warmup that has not run yet.
    return new Promise<void>((resolve) => { this.wakePendingStart = resolve; });
  }

  private async warmupIfNeeded(
    audio: HTMLAudioElement,
    startRatio: number,
  ): Promise<boolean> {
    if (!this.warmupNextPlayback || startRatio > 0 || this.muted || this.volume <= 0) {
      this.warmupNextPlayback = false;
      return this.audio === audio;
    }

    this.warmupAudio = audio;
    this.applyVolume();
    await this.playWhenReady(audio);
    await new Promise<void>((resolve) => window.setTimeout(resolve, PLAYBACK_WARMUP_MS));
    if (this.audio !== audio || this.warmupAudio !== audio) return false;

    audio.pause();
    await this.rewindAfterWarmup(audio);
    if (this.audio !== audio || this.warmupAudio !== audio) return false;
    this.warmupAudio = null;
    this.warmupNextPlayback = false;
    this.applyVolume();
    return true;
  }

  private async downloadAudio(url: string): Promise<Blob> {
    const controller = new AbortController();
    this.pendingDownload = controller;
    const timeout = window.setTimeout(() => controller.abort(), MEDIA_WAIT_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`语音加载失败（${response.status}），请点击播放重试`);
      return await response.blob();
    } catch (error) {
      if (controller.signal.aborted) throw new Error('语音加载超时，请检查网络后点击播放重试');
      throw error;
    } finally {
      window.clearTimeout(timeout);
      if (this.pendingDownload === controller) this.pendingDownload = null;
    }
  }

  /** Browsers can leave play() pending indefinitely while media is loading. */
  private playWhenReady(audio: HTMLAudioElement): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        audio.removeEventListener('error', onError);
        if (this.cancelMediaStart === cancel) this.cancelMediaStart = null;
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => finish(new Error('语音播放已取消'));
      const onError = () => finish(new Error('语音加载失败，请点击播放重试'));
      const timeout = window.setTimeout(() => finish(new Error('语音加载超时，请检查网络后点击播放重试')), MEDIA_WAIT_TIMEOUT_MS);
      this.cancelMediaStart = cancel;
      audio.addEventListener('error', onError);
      try { void audio.play().then(() => finish(), finish); }
      catch (error) { finish(error); }
    });
  }

  private failActiveAudio(error: Error): void {
    this.clearCurrentAudio();
    this.onErrorCallback?.(error);
  }

  private monitorPlayback(audio: HTMLAudioElement): void {
    this.stopMonitoring?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastTime = audio.currentTime;
    const clearWait = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    const onError = () => {
      if (this.audio === audio) this.failActiveAudio(new Error('语音播放中断，请点击播放重试当前讲解'));
    };
    const onWait = () => {
      if (timer !== undefined || this.playbackPaused || audio.ended) return;
      lastTime = audio.currentTime;
      timer = setTimeout(() => {
        timer = undefined;
        if (this.audio === audio && !this.playbackPaused && !audio.ended) {
          this.failActiveAudio(new Error('语音缓冲超时，请检查网络后点击播放重试当前讲解'));
        }
      }, MEDIA_WAIT_TIMEOUT_MS);
    };
    const onProgress = () => {
      if (audio.currentTime !== lastTime) clearWait();
      lastTime = audio.currentTime;
    };
    audio.addEventListener('error', onError);
    audio.addEventListener('waiting', onWait);
    audio.addEventListener('stalled', onWait);
    audio.addEventListener('timeupdate', onProgress);
    audio.addEventListener('playing', clearWait);
    audio.addEventListener('pause', clearWait);
    audio.addEventListener('ended', clearWait);
    this.stopMonitoring = () => {
      clearWait();
      audio.removeEventListener('error', onError);
      audio.removeEventListener('waiting', onWait);
      audio.removeEventListener('stalled', onWait);
      audio.removeEventListener('timeupdate', onProgress);
      audio.removeEventListener('playing', clearWait);
      audio.removeEventListener('pause', clearWait);
      audio.removeEventListener('ended', clearWait);
    };
  }

  /**
   * Setting currentTime starts an asynchronous seek in real browsers. Starting
   * playback again before `seeked` can continue from the quiet pre-roll and
   * permanently skip the first words, so wait until the media pipeline has
   * actually returned to the beginning.
   */
  private async rewindAfterWarmup(audio: HTMLAudioElement): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Timed out while rewinding audio after playback warmup'));
      }, PLAYBACK_REWIND_TIMEOUT_MS);
      const cleanup = () => {
        window.clearTimeout(timeout);
        audio.removeEventListener('seeked', onSeeked);
        audio.removeEventListener('error', onError);
      };
      const onSeeked = () => {
        cleanup();
        if (!audio.seeking && Math.abs(audio.currentTime) <= PLAYBACK_REWIND_EPSILON_SECONDS) {
          resolve();
        } else {
          reject(new Error('Audio did not return to the beginning after playback warmup'));
        }
      };
      const onError = () => {
        cleanup();
        reject(new Error('Audio failed while rewinding after playback warmup'));
      };
      audio.addEventListener('seeked', onSeeked, { once: true });
      audio.addEventListener('error', onError, { once: true });
      try {
        audio.currentTime = 0;
        if (!audio.seeking) onSeeked();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  /** Seek after metadata is available so subtitle clicks start at that sentence. */
  private async seekToRatioWhenReady(audio: HTMLAudioElement, ratio: number): Promise<void> {
    const normalizedRatio = Math.max(0, Math.min(0.999, ratio));
    if (normalizedRatio <= 0) return;
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error('Timed out while loading audio metadata for subtitle seek'));
        }, 8_000);
        const cleanup = () => {
          window.clearTimeout(timeout);
          audio.removeEventListener('loadedmetadata', onMetadata);
          audio.removeEventListener('error', onError);
        };
        const onMetadata = () => {
          cleanup();
          if (Number.isFinite(audio.duration) && audio.duration > 0) resolve();
          else reject(new Error('Audio duration is unavailable for subtitle seek'));
        };
        const onError = () => {
          cleanup();
          reject(new Error('Audio metadata could not be loaded for subtitle seek'));
        };
        audio.addEventListener('loadedmetadata', onMetadata, { once: true });
        audio.addEventListener('error', onError, { once: true });
        audio.load();
      });
    }
    if (this.audio !== audio) return;

    const targetTime = audio.duration * normalizedRatio;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Timed out while seeking to subtitle position'));
      }, 8_000);
      const cleanup = () => {
        window.clearTimeout(timeout);
        audio.removeEventListener('seeked', onSeeked);
        audio.removeEventListener('error', onError);
      };
      const onSeeked = () => {
        cleanup();
        // A server without byte-range support can report seeked while still at
        // zero. Retry through the downloaded blob rather than starting there.
        if (Math.abs(audio.currentTime - targetTime) <= 0.05) resolve();
        else reject(new Error('Audio could not seek to subtitle position'));
      };
      const onError = () => {
        cleanup();
        reject(new Error('Audio could not be loaded for subtitle seek'));
      };
      audio.addEventListener('seeked', onSeeked);
      audio.addEventListener('error', onError);
      try {
        audio.currentTime = targetTime;
        if (!audio.seeking && Math.abs(audio.currentTime - targetTime) <= 0.05) onSeeked();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
}

/**
 * Create an audio player instance
 */
export function createAudioPlayer(): AudioPlayer {
  return new AudioPlayer();
}
