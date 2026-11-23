import type { Chart, ChartConfig, TargetSpec } from './types.ts';

/** 一拍多少秒。 */
export function secondsPerBeat(bpm: number): number {
  return 60 / bpm;
}

/** 拍号 → 歌曲时间（秒）。 */
export function beatToTime(beat: number, bpm: number): number {
  return beat * secondsPerBeat(bpm);
}

/** 歌曲时间（秒）→ 拍号（可为小数）。 */
export function timeToBeat(t: number, bpm: number): number {
  return t / secondsPerBeat(bpm);
}

/** 拍号 → 0 基的 [小节, 小节内拍]，均为 0 基，显示时 +1。 */
export function beatToMeasureBeat(
  beat: number,
  beatsPerMeasure: number,
): { measure: number; beatInMeasure: number } {
  const b = Math.max(0, beat);
  return {
    measure: Math.floor(b / beatsPerMeasure),
    beatInMeasure: b - Math.floor(b / beatsPerMeasure) * beatsPerMeasure,
  };
}

/** 某一小节第一拍的拍号。 */
export function measureStartBeat(measure: number, beatsPerMeasure: number): number {
  return measure * beatsPerMeasure;
}

/** 谱面总时长（秒），尾部留出一拍余量给最后一块板结算。 */
export function chartDuration(chart: Chart): number {
  const cfg = chart.config;
  const lastEnd = chart.targets.reduce(
    (m, t) => Math.max(m, t.beat + t.lengthBeats),
    cfg.measures * cfg.beatsPerMeasure - 1,
  );
  return beatToTime(lastEnd + 1, cfg.bpm);
}

/** 校验拍位文本，返回谱面或错误信息。文本每行：轨,拍[,持续拍]，# 开头为注释。 */
export function parseTargetLine(
  line: string,
  index: number,
): { spec?: TargetSpec; error?: string } {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return {};
  const parts = trimmed.split(/[,\s]+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) {
    return { error: `第 ${index + 1} 行格式应为：轨,拍[,持续拍]` };
  }
  const lane = parts[0];
  const beat = Number(parts[1]);
  const lengthBeats = parts.length === 3 ? Number(parts[2]) : 0;
  if (!Number.isFinite(beat) || beat < 0) {
    return { error: `第 ${index + 1} 行拍号非法：${parts[1]}` };
  }
  if (!Number.isFinite(lengthBeats) || lengthBeats < 0) {
    return { error: `第 ${index + 1} 行持续拍数非法：${parts[2] ?? ''}` };
  }
  return {
    spec: {
      id: `T${index + 1}`,
      lane,
      beat,
      lengthBeats,
    },
  };
}

export function buildChart(config: ChartConfig, text: string): { chart?: Chart; errors: string[] } {
  const errors: string[] = [];
  const targets: TargetSpec[] = [];
  text.split('\n').forEach((line, i) => {
    const { spec, error } = parseTargetLine(line, i);
    if (error) errors.push(error);
    if (spec) targets.push(spec);
  });
  if (config.bpm <= 0) errors.push('BPM 必须大于 0');
  if (config.perfectWindow <= 0 || config.goodWindow <= 0) {
    errors.push('判定窗口必须大于 0');
  }
  if (config.perfectWindow > config.goodWindow) {
    errors.push('perfect 窗口不能大于 good 窗口');
  }
  if (errors.length) return { errors };
  return { chart: { config, targets }, errors };
}
