// Flicker / ghosting metrics on a fixed measurement region (ROI).
// The "ground truth" for every frame is the direct (history-free) current frame;
// the temporal composite is compared against it pixel by pixel.

export interface FrameSample {
  f: number;
  meanAbsLuma: number;   // 0..255 scale, temporal vs direct
  maxAbsLuma: number;
  reuseFraction: number; // effective history fraction in the ROI, 0..1
}

export interface TrialSummary {
  clipId: string;
  frames: number;
  flickerAmp: number;      // mean over active frames of meanAbsLuma
  flickerPeak: number;
  reuseMean: number;
  recoveryFrames: number;  // -1 if it never settles inside the clip
}

/**
 * Recovery: smallest absolute frame index >= `fromFrame` where error stays
 * below the threshold for `hold` consecutive frames.
 * Default threshold 1.5/255 luma: RGBA8 quantization leaves a ~0.9 floor even
 * after perfect convergence, so 2.0 would report "never settles" falsely.
 */
export function findRecovery(
  samples: FrameSample[],
  fromFrame: number,
  threshold = 1.5,
  hold = 3,
): number {
  for (let k = fromFrame; k + hold <= samples.length; k++) {
    let ok = true;
    for (let j = 0; j < hold; j++) {
      if (samples[k + j].meanAbsLuma > threshold) {
        ok = false;
        break;
      }
    }
    if (ok) return k;
  }
  return -1;
}

export function summarize(
  clipId: string,
  samples: FrameSample[],
  activeFrom: number,
  recoverFrom: number,
): TrialSummary {
  const active = samples.slice(activeFrom);
  const flickerAmp =
    active.reduce((a, s) => a + s.meanAbsLuma, 0) / Math.max(1, active.length);
  const flickerPeak = active.reduce((a, s) => Math.max(a, s.maxAbsLuma), 0);
  const reuseMean =
    active.reduce((a, s) => a + s.reuseFraction, 0) / Math.max(1, active.length);
  const settleFrame = findRecovery(samples, recoverFrom);
  return {
    clipId,
    frames: samples.length,
    flickerAmp,
    flickerPeak,
    reuseMean,
    // Report frames elapsed between the settle phase start and first settled frame.
    recoveryFrames: settleFrame < 0 ? -1 : settleFrame - recoverFrom,
  };
}

/** Average matching-frame samples across repeated identical trials. */
export function averageTrials(runs: FrameSample[][]): FrameSample[] {
  if (runs.length === 0) return [];
  const n = Math.min(...runs.map((r) => r.length));
  const out: FrameSample[] = [];
  for (let i = 0; i < n; i++) {
    let a = 0;
    let p = 0;
    let u = 0;
    for (const run of runs) {
      a += run[i].meanAbsLuma;
      p += run[i].maxAbsLuma;
      u += run[i].reuseFraction;
    }
    out.push({
      f: runs[0][i].f,
      meanAbsLuma: a / runs.length,
      maxAbsLuma: p / runs.length,
      reuseFraction: u / runs.length,
    });
  }
  return out;
}

export function averageSummaries(runs: TrialSummary[]): TrialSummary {
  const n = Math.max(1, runs.length);
  const rec = runs.map((r) => r.recoveryFrames).filter((v) => v >= 0);
  return {
    clipId: runs[0]?.clipId ?? '',
    frames: runs[0]?.frames ?? 0,
    flickerAmp: runs.reduce((a, r) => a + r.flickerAmp, 0) / n,
    flickerPeak: runs.reduce((a, r) => a + r.flickerPeak, 0) / n,
    reuseMean: runs.reduce((a, r) => a + r.reuseMean, 0) / n,
    recoveryFrames: rec.length
      ? Math.round(rec.reduce((a, v) => a + v, 0) / rec.length)
      : -1,
  };
}
