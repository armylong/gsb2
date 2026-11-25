/**
 * 实测频谱测量与成分分类。
 * 关键纪律：只有“实测 FFT 里真的测到的峰”才能被标成真实成分；
 * 正弦例里不存在的额外频率，绝不显示成真实谐波。
 */
import { hannWindow, realDft, toDb } from './fft';
import { foldFrequency, type HarmonicCoeffs } from './wavetable';

export interface Peak {
  freq: number;
  magnitude: number;
  db: number;
  bin: number;
}

export type PeakKind = 'harmonic' | 'alias' | 'extra';

export interface ClassifiedPeak extends Peak {
  kind: PeakKind;
  /** 归属的理论谐波次数（harmonic / alias 时有效） */
  harmonicK?: number;
  /** alias 时记录其未折叠前的原始频率 */
  sourceFreq?: number;
}

export interface HarmonicRow {
  k: number;
  idealFreq: number;
  idealDb: number;
  inBand: boolean;
  measured?: Peak;
  status: 'ok' | 'missing' | 'out-of-band' | 'folded';
  /** 折叠后落在何处（仅 folded） */
  foldedFreq?: number;
}

export interface MeasurementResult {
  sampleRate: number;
  fftSize: number;
  f0: number;
  mode: 'naive' | 'bandlimited';
  /** FFT 全谱（降采样后用于画图），频率 Hz 与 dB */
  spectrumFreq: Float64Array;
  spectrumDb: Float64Array;
  rawPeaks: Peak[];
  classified: ClassifiedPeak[];
  rows: HarmonicRow[];
  /** 理论上存在且幅度够大的谐波次数清单（波形 DFT） */
  idealHarmonics: { k: number; freq: number; mag: number; db: number; inBand: boolean }[];
  noiseFloorDb: number;
}

const IDEAL_FLOOR_DB = -96; // 理论谐波低于此值视为该分量不存在
const PEAK_THRESHOLD_DB = -78; // 实测峰绝对门限（电平器慢调制边带约 -73dB 以下需更严判据）
const MATCH_TOLERANCE_BINS = 1.5; // 实测峰与理论频率的匹配容差（按 FFT bin 宽计，保证频率归属严格）
const PEAK_PROMINENCE_DB = 12; // 峰必须高出全局噪声地板这么多
const LEVELER_SIDEBAND_DB = -70; // 未解释弱峰低于此值视为电平器/量化边带，不算真 extra（理论匹配通道不受此限）
const TARGETED_FLOOR_DB = -85; // 理论位置定向搜索的绝对门限（只作用于理论谐波/折叠点）
const HANN_FIRST_SIDELOBE_DB = -31.5; // Hann 窗第一旁瓣相对主瓣
const HANN_SIDELOBE_FALLOFF = 18; // 每十倍频程（按 bin 距离）旁瓣衰减 dB

/**
 * 无条件旁瓣上界判断（用于 extra 轮）：峰幅度是否不超过任一理论源在该偏移下的
 * Hann 窗旁瓣上界 + 3dB 裕量。落在主瓣 1.5 bin 内的位置不应走旁瓣解释（应精确匹配）。
 */
function withinSidelobeEnvelope(
  peak: Peak,
  sources: { freq: number; db: number }[],
  binHz: number,
): boolean {
  for (const s of sources) {
    const dBin = Math.abs(peak.freq - s.freq) / binHz;
    if (dBin < 1.5) continue;
    const maskDb =
      s.db - HANN_FIRST_SIDELOBE_DB - HANN_SIDELOBE_FALLOFF * Math.log10(dBin / 1.5);
    if (peak.db <= maskDb + 3) return true;
  }
  return false;
}

/**
 * 判断一个未匹配峰能否被理论源的 Hann 窗频谱泄漏解释（用于折叠轮）。
 * 两个条件同时满足才算“可解释为旁瓣”：
 *   1. 峰幅度不超过最近理论源在该 bin 偏移下的旁瓣上界 + 3dB 裕量；
 *   2. 该点不是局部极大值（真实折叠/谐波分量自身有峰形，给予豁免）。
 */
function isExplainedBySidelobe(
  peak: Peak,
  sources: { freq: number; db: number }[],
  binHz: number,
  isLocalMaximum: boolean,
): boolean {
  if (isLocalMaximum) return false;
  return withinSidelobeEnvelope(peak, sources, binHz);
}

/** 对一段稳态信号做 Hann 加窗 FFT，取尾部片段。 */
export function measureSpectrum(
  signal: Float64Array,
  sampleRate: number,
  fftSize = 16384,
): {
  freq: Float64Array;
  db: Float64Array;
  peaks: Peak[];
  noiseFloorDb: number;
  targetedAt: (targetFreq: number) => Peak | undefined;
} {
  const n = Math.min(fftSize, signal.length);
  if ((n & (n - 1)) !== 0) throw new Error('FFT 长度必须是 2 的幂');
  const start = signal.length - n;
  const win = hannWindow(n);
  const windowed = new Float64Array(n);
  for (let i = 0; i < n; i++) windowed[i] = signal[start + i] * win[i];

  const { re, im } = realDft(windowed);
  const bins = n >> 1;
  // Hann 窗相干增益 0.5，幅度补偿 ×2
  const gainComp = 2 / (0.5 * n);
  const freq = new Float64Array(bins + 1);
  const db = new Float64Array(bins + 1);
  const mags = new Float64Array(bins + 1);
  for (let k = 0; k <= bins; k++) {
    const mag = Math.hypot(re[k], im[k]) * gainComp;
    freq[k] = (k * sampleRate) / n;
    mags[k] = mag;
    db[k] = toDb(mag);
  }

  // 噪声地板：取 40% 分位 dB（避开静音与信号峰）
  const sorted = Array.from(db).sort((a, b) => a - b);
  const noiseFloorDb = sorted[Math.floor(sorted.length * 0.4)];

  // 局部极大值挑峰：高于绝对门限，且显著高出全局噪声地板。
  // 绝对门限挡住 RMS 电平归一器的慢增益调制边带（约 -73dB 及以下），
  // 显著性要求排除量化/泄漏造成的零星隆起；两者结合不误杀凹口波形的真实弱谐波。
  const peaks: Peak[] = [];
  const peakByBin = new Map<number, Peak>();
  for (let k = 2; k < bins; k++) {
    if (!(mags[k] > mags[k - 1] && mags[k] >= mags[k + 1])) continue;
    if (db[k] <= PEAK_THRESHOLD_DB) continue;
    if (db[k] < noiseFloorDb + PEAK_PROMINENCE_DB) continue;
    const peak = { bin: k, freq: freq[k], magnitude: mags[k], db: db[k] };
    peaks.push(peak);
    peakByBin.set(k, peak);
  }

  /**
   * 理论位置定向搜索：弱谐波可能落在强邻峰的 Hann 旁瓣斜坡上而不是局部极大值，
   * 因此在理论频率 ±1 bin 内按“距目标最近优先、强度次之”挑一个合格谱值补峰。
   * 只在“理论上该有分量”的位置调用，门限比盲扫峰松（噪声地板 +6dB），
   * 不会给正弦这类纯波形引入任何额外频率。
   */
  const targetedAt = (targetFreq: number): Peak | undefined => {
    const center = Math.round((targetFreq / sampleRate) * n);
    const candidates: { k: number; dist: number }[] = [];
    for (let d = -1; d <= 1; d++) {
      const k = center + d;
      if (k < 2 || k >= bins) continue;
      if (db[k] <= TARGETED_FLOOR_DB || db[k] < noiseFloorDb + 6) continue;
      candidates.push({ k, dist: Math.abs(freq[k] - targetFreq) });
    }
    if (!candidates.length) return undefined;
    candidates.sort((a, b) => a.dist - b.dist || db[b.k] - db[a.k]);
    const k = candidates[0].k;
    const existing = peakByBin.get(k);
    if (existing) return existing;
    return { bin: k, freq: freq[k], magnitude: mags[k], db: db[k] };
  };

  return { freq, db, peaks, noiseFloorDb, targetedAt };
}

/**
 * 完整分类：
 * 1. 波形 DFT 决定“理论上有哪些谐波”；
 * 2. 实测峰先匹配基带内理论谐波 → harmonic；
 * 3. 再匹配越界谐波的折叠落点 → alias；
 * 4. 都不沾边的才是 extra（真实多出的峰）。
 */
export function classifyMeasurement(
  signal: Float64Array,
  sampleRate: number,
  f0: number,
  mode: 'naive' | 'bandlimited',
  coeffs: HarmonicCoeffs,
  fftSize = 16384,
): MeasurementResult {
  const { freq, db, peaks, noiseFloorDb, targetedAt } = measureSpectrum(signal, sampleRate, fftSize);
  const nyquist = sampleRate / 2;
  const bins = coeffs.n >> 1;
  const toleranceHz = (sampleRate / fftSize) * MATCH_TOLERANCE_BINS;

  // 理论谐波（只保留幅度有意义的）
  const idealHarmonics = [];
  for (let k = 1; k <= bins; k++) {
    const mag = coeffs.mag[k];
    const d = toDb(mag);
    if (d < IDEAL_FLOOR_DB) continue;
    const hf = k * f0;
    idealHarmonics.push({ k, freq: hf, mag, db: d, inBand: hf < nyquist });
  }

  const usedPeaks = new Set<number>();
  const classified: ClassifiedPeak[] = [];
  const rows: HarmonicRow[] = [];

  // 第一轮：基带内理论谐波匹配实测峰（定向搜索优先，兜底最近峰）
  for (const h of idealHarmonics) {
    if (!h.inBand) continue;
    const match = matchTheoretical(h.freq, targetedAt, peaks, usedPeaks, toleranceHz);
    const row: HarmonicRow = {
      k: h.k,
      idealFreq: h.freq,
      idealDb: h.db,
      inBand: true,
      status: match ? 'ok' : 'missing',
      measured: match,
    };
    if (match) {
      usedPeaks.add(match.bin);
      classified.push({ ...match, kind: 'harmonic', harmonicK: h.k });
    }
    rows.push(row);
  }

  // 第二轮：越界谐波 → 折叠落点匹配（这是 A 模式“低响”的来源）。
  // 基带强谐波的位置/强度，用于判断折叠点是否只是 Hann 窗旁瓣。
  // 先把折叠源按目标 bin 聚合：多个镜像谐波本就折到同一频率，共享一个实测峰。
  const inBandSources = idealHarmonics
    .filter((h) => h.inBand)
    .map((h) => ({ freq: h.freq, db: h.db }));
  const foldGroups = new Map<number, { row: HarmonicRow; folded: number }[]>();
  for (const h of idealHarmonics) {
    if (h.inBand) continue;
    const folded = foldFrequency(h.freq, sampleRate);
    const row: HarmonicRow = {
      k: h.k,
      idealFreq: h.freq,
      idealDb: h.db,
      inBand: false,
      foldedFreq: folded,
      status: 'folded',
    };
    rows.push(row);
    const clashWithInBand = idealHarmonics.some(
      (other) => other.inBand && Math.abs(other.freq - folded) < toleranceHz,
    );
    if (clashWithInBand) continue;
    const centerBin = Math.round((folded / sampleRate) * fftSize);
    const group = foldGroups.get(centerBin) ?? [];
    group.push({ row, folded });
    foldGroups.set(centerBin, group);
  }

  for (const group of foldGroups.values()) {
    // 组内取最强源的折叠点作为匹配目标（同 bin 频率差远小于一个 bin）
    const target = group[0].folded;
    // 折叠匹配只按“频率位置”归属，完全不看占用状态：
    // 同一实测峰可以既是基带谐波、又是某越界谐波的折叠落点（两种身份都记录）。
    let match = nearestPeak(peaks, target, toleranceHz, new Set());
    if (!match) match = targetedAt(target);
    // 严格匹配落空时，A 模式允许 3 bin 宽的二次匹配：
    // 折叠分量密集时实测峰会偏离理论落点 1~2 bin，只要显著高于噪声即归属折叠而非 extra
    if (!match && mode === 'naive') {
      const loose = nearestPeak(peaks, target, toleranceHz * 2, new Set());
      if (loose && loose.db >= noiseFloorDb + 12) match = loose;
    }
    if (!match) continue;
    // 折叠点若只是某个基带强谐波的 Hann 窗旁瓣，不算真实折叠分量。
    // B 限带模式无条件套旁瓣上界（越界源已被淡出到 0，任何基带能量都来自泄漏）；
    // A 模式保留局部极大值豁免（真实折叠峰自身有峰形）。
    const isLocalMax = peaks.some((p) => p.bin === match!.bin);
    const maskedBySidelobe =
      mode === 'bandlimited'
        ? withinSidelobeEnvelope(match, inBandSources, sampleRate / fftSize)
        : isExplainedBySidelobe(match, inBandSources, sampleRate / fftSize, isLocalMax);
    // B 限带模式本应把越界谐波淡出到 0：只有显著高出噪声地板（≥15dB）的折叠峰才确认，
    // 避免把窗泄漏/噪声旁瓣误报成 alias；A 模式不存在限带，按正常门限确认。
    const strongEnough = mode === 'naive' || match.db >= noiseFloorDb + 15;
    if (!strongEnough || maskedBySidelobe) continue;

    // 标记该 bin 已被折叠解释，第三轮不再算 extra（但不影响它的基带谐波身份）
    usedPeaks.add(match.bin);
    for (const { row } of group) {
      row.measured = match;
      classified.push({
        ...match,
        kind: 'alias',
        harmonicK: row.k,
        sourceFreq: row.idealFreq,
      });
    }
  }

  // 第三轮：剩余实测峰 → extra，先用 Hann 窗旁瓣掩蔽与电平器门限排除“伪 extra”。
  // 纪律：正弦例里不存在的额外频率绝不显示成真实谐波。
  const binHz = sampleRate / fftSize;
  // 所有能在基带产生能量的理论源：基带谐波 + 越界谐波的折叠落点
  const sources = [
    ...idealHarmonics.filter((h) => h.inBand).map((h) => ({ freq: h.freq, db: h.db })),
    ...idealHarmonics
      .filter((h) => !h.inBand)
      .map((h) => ({ freq: foldFrequency(h.freq, sampleRate), db: h.db })),
  ];
  for (const p of peaks) {
    if (usedPeaks.has(p.bin)) continue;
    // 电平归一器慢增益调制边带：绝对幅度很弱，单独门限拦截
    if (p.db < LEVELER_SIDEBAND_DB) continue;
    // 此轮无条件套用旁瓣上界：能被任一理论源的 Hann 泄漏解释的弱峰不算真 extra
    if (withinSidelobeEnvelope(p, sources, binHz)) continue;
    classified.push({ ...p, kind: 'extra' });
    usedPeaks.add(p.bin);
  }

  rows.sort((a, b) => a.k - b.k);

  return {
    sampleRate,
    fftSize,
    f0,
    mode,
    spectrumFreq: freq,
    spectrumDb: db,
    rawPeaks: peaks,
    classified,
    rows,
    idealHarmonics,
    noiseFloorDb,
  };
}

function nearestPeak(
  peaks: Peak[],
  target: number,
  tolerance: number,
  used: Set<number>,
): Peak | undefined {
  let best: Peak | undefined;
  let bestDist = tolerance;
  for (const p of peaks) {
    if (used.has(p.bin)) continue;
    const d = Math.abs(p.freq - target);
    if (d <= bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

/**
 * 理论位置匹配：先用定向搜索（能找回旁瓣斜坡上的弱谐波），
 * 再用最近邻兜底；命中的 bin 记入 used，同一实测峰绝不归属两个理论分量。
 * 两个来源都强制落在 toleranceHz 内，保证频率归属严格、折叠公式可复验。
 */
function matchTheoretical(
  target: number,
  targetedAt: (f: number) => Peak | undefined,
  peaks: Peak[],
  used: Set<number>,
  toleranceHz: number,
): Peak | undefined {
  const targeted = targetedAt(target);
  if (targeted && !used.has(targeted.bin) && Math.abs(targeted.freq - target) <= toleranceHz) {
    return targeted;
  }
  return nearestPeak(peaks, target, toleranceHz, used);
}

/** 把全分辨率谱降采样到最多 maxPoints 个点（每段取最大 dB，保留峰形）。 */
export function downsampleSpectrum(
  freq: Float64Array,
  db: Float64Array,
  maxPoints = 1400,
): { freq: Float64Array; db: Float64Array } {
  if (freq.length <= maxPoints) return { freq, db };
  const step = Math.ceil(freq.length / maxPoints);
  const outLen = Math.ceil(freq.length / step);
  const outF = new Float64Array(outLen);
  const outDb = new Float64Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = i * step;
    const end = Math.min(freq.length, start + step);
    let bestDb = -Infinity;
    let bestIdx = start;
    for (let j = start; j < end; j++) {
      if (db[j] > bestDb) {
        bestDb = db[j];
        bestIdx = j;
      }
    }
    outF[i] = freq[bestIdx];
    outDb[i] = bestDb;
  }
  return { freq: outF, db: outDb };
}
