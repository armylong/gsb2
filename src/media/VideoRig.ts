import { MEDIA_SOURCES } from '../core/config';
import { clamp } from '../core/format';
import type { ActualRouteState, RouteId, SimState } from '../core/types';

const ROUTES: RouteId[] = ['A', 'B'];

export class VideoRig {
  readonly videos: Record<RouteId, HTMLVideoElement>;
  readonly actual: Record<RouteId, ActualRouteState>;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private errors: Partial<Record<RouteId, string>> = {};
  private readonly observedSeekNonce: Record<RouteId, number> = { A: 0, B: 0 };

  constructor(videos: Record<RouteId, HTMLVideoElement>, canvas: HTMLCanvasElement) {
    this.videos = videos;
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;

    this.actual = {
      A: this.readActual('A'),
      B: this.readActual('B'),
    };

    for (const id of ROUTES) {
      const video = videos[id];
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.crossOrigin = 'anonymous';
      video.addEventListener('error', () => {
        this.errors[id] = video.error ? `MediaError ${video.error.code}` : 'unknown media error';
      });
    }
  }

  async load(): Promise<void> {
    let sources: Record<RouteId, string> = { ...MEDIA_SOURCES };
    try {
      const response = await fetch('/media/manifest.json', { cache: 'no-cache' });
      if (response.ok) {
        const manifest = (await response.json()) as Partial<Record<RouteId, string>>;
        if (manifest.A && manifest.B) sources = { A: manifest.A, B: manifest.B };
      }
    } catch {
      // The committed MP4 paths remain the fallback.
    }

    await Promise.all(
      ROUTES.map(
        id =>
          new Promise<void>((resolve, reject) => {
            const video = this.videos[id];
            if (!video.getAttribute('src')) video.src = sources[id];
            if (video.readyState >= 2) return resolve();
            const timer = window.setTimeout(() => resolve(), 9000);
            video.addEventListener(
              'canplay',
              () => {
                window.clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
            video.addEventListener(
              'error',
              () => {
                window.clearTimeout(timer);
                reject(new Error(`视频 ${id} 加载失败`));
              },
              { once: true },
            );
            video.load();
          }),
      ),
    );
  }

  private readActual(id: RouteId): ActualRouteState {
    const video = this.videos?.[id];
    return {
      id,
      currentTime: video?.currentTime ?? 0,
      paused: video?.paused ?? true,
      ended: video?.ended ?? false,
      readyState: video?.readyState ?? 0,
      seeking: video?.seeking ?? false,
      playbackRate: video?.playbackRate ?? 1,
      videoWidth: video?.videoWidth ?? 0,
      videoHeight: video?.videoHeight ?? 0,
      networkState: video?.networkState ?? 0,
      error: this.errors[id] ?? null,
    };
  }

  sync(state: SimState, playing: boolean, scrubbing: boolean): void {
    for (const id of ROUTES) {
      const video = this.videos[id];
      const source = state.sources[id];
      const shouldPlay = playing && !scrubbing && source.health === 'ok';
      // Do not let 4x playback advance the clip while an alignment seek is
      // completing; the rate is restored on the frame after `seeked`.
      const desiredRate = shouldPlay && !video.seeking ? source.rate : 1;
      if (Math.abs(video.playbackRate - desiredRate) > 0.001) {
        video.playbackRate = desiredRate;
      }

      const threshold = scrubbing || !playing ? 0.035 : 0.28;
      const desiredTime = clamp(source.pts, 0, Number.isFinite(video.duration) ? video.duration - 0.02 : state.duration);
      const explicitAlign = source.seekNonce !== this.observedSeekNonce[id];

      // While scrubbing, always retarget the decoder to the exact inspected
      // PTS. During playback, never interrupt an in-flight alignment seek to
      // chase the fast-forwarding target; playback rate closes that gap.
      if (explicitAlign) {
        this.observedSeekNonce[id] = source.seekNonce;
        if (!video.seeking || Math.abs(video.currentTime - desiredTime) > 0.08) {
          video.currentTime = desiredTime;
        }
      } else if (scrubbing) {
        if (Math.abs(video.currentTime - desiredTime) > threshold) {
          video.currentTime = desiredTime;
        }
      } else if (!video.seeking && Math.abs(video.currentTime - desiredTime) > threshold) {
        video.currentTime = desiredTime;
      }

      if (shouldPlay && video.paused && video.readyState >= 2) {
        void video.play().catch(() => {
          // Autoplay can be interrupted by a rapid pause/seek; next frame retries.
        });
      } else if (!shouldPlay && !video.paused) {
        video.pause();
      }

      this.actual[id] = {
        ...this.readActual(id),
        currentTime: video.currentTime,
        paused: video.paused,
        ended: video.ended,
        readyState: video.readyState,
        seeking: video.seeking,
        playbackRate: video.playbackRate,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        networkState: video.networkState,
        error: this.errors[id] ?? null,
      };
    }

    this.drawProgram(state);
  }

  private drawProgram(state: SimState): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const routeToDraw = state.output ?? state.lastOutput;
    const video = routeToDraw ? this.videos[routeToDraw] : null;
    if (video && video.readyState >= 2 && video.videoWidth > 0) {
      ctx.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
    } else {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.fillStyle = '#64748b';
      ctx.font = '900 72px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('NO MEDIA FRAME', this.canvas.width / 2, this.canvas.height / 2);
    }

    if (state.programState === 'no-source' || state.programState === 'locked-bad') {
      ctx.fillStyle = 'rgba(2, 6, 23, 0.62)';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  getActualStates(): Record<RouteId, ActualRouteState> {
    return { A: { ...this.actual.A }, B: { ...this.actual.B } };
  }
}
