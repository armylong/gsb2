import type { Renderer, BlendWeights } from '../webgl/renderer';
import {
  CLIPS,
  createConfig,
  createInitialState,
  type Clip,
} from '../scene/sim';
import {
  averageSummaries,
  averageTrials,
  summarize,
  type FrameSample,
  type TrialSummary,
} from '../metrics/metrics';

export interface TrialCallbacks {
  onProgress: (clipIndex: number, repeat: number, repeats: number, frame: number, total: number) => void;
  onClipDone: (clip: Clip, avg: FrameSample[], summary: TrialSummary) => void;
  onAllDone: () => void;
}

/**
 * Runs every built-in clip N times with identical motion. Between repeats the
 * history caches are reset, so each run starts from the same cold state and the
 * averaged per-frame curves are directly comparable.
 */
export class TrialRunner {
  private stopped = false;
  private running = false;

  constructor(private renderer: Renderer) {}

  get isRunning(): boolean {
    return this.running;
  }

  get wasStopped(): boolean {
    return this.stopped;
  }

  stop(): void {
    this.stopped = true;
  }

  async run(
    width: number,
    height: number,
    repeats: number,
    blend: BlendWeights,
    cb: TrialCallbacks,
  ): Promise<void> {
    this.running = true;
    this.stopped = false;
    const cfg = createConfig(width, height);

    for (let ci = 0; ci < CLIPS.length; ci++) {
      if (this.stopped) break;
      const clip = CLIPS[ci];
      const runs: FrameSample[][] = [];

      for (let rep = 0; rep < repeats; rep++) {
        if (this.stopped) break;
        const s = createInitialState(cfg);
        clip.init(s, cfg);
        this.renderer.invalidateHistory();
        const samples: FrameSample[] = [];

        for (let f = 0; f < clip.duration; f++) {
          if (this.stopped) break;
          clip.apply(s, cfg, f);
          this.renderer.render(s, blend);
          const stats = this.renderer.regionStats();
          samples.push({ f, ...stats });
          cb.onProgress(ci, rep, repeats, f, clip.duration);
          // Yield to the event loop every 8 frames so the UI stays responsive.
          if (f % 8 === 0) await new Promise((r) => setTimeout(r, 0));
        }
        runs.push(samples);
      }

      if (!this.stopped && runs.length > 0) {
        const avg = averageTrials(runs);
        const summaries = runs.map((r) =>
          summarize(
            clip.id,
            r,
            clip === CLIPS[0] ? 0 : 0,
            clip === CLIPS[0] ? 130 : 115,
          ),
        );
        cb.onClipDone(clip, avg, averageSummaries(summaries));
      }
    }
    this.running = false;
    cb.onAllDone();
  }
}
