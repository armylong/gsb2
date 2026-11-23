import { Engine } from './engine.ts';
import { beatToTime } from './chart.ts';
import type { Chart, ChartConfig, InputEvent, JudgementRow, RuntimeTarget } from './types.ts';

/** 样例规则参数（120BPM 下一拍 = 0.5s）。 */
export const SAMPLE_CONFIG: ChartConfig = {
  bpm: 120,
  beatsPerMeasure: 4,
  measures: 4,
  perfectWindow: 0.05,
  goodWindow: 0.12,
};

/**
 * 样例谱面（F/J 两块板），覆盖题面要求的全部情形：
 *  F beat0  tap        正常命中（早 20ms → perfect）
 *  F beat1  tap        与下一块窗口重叠（间距 0.2s < 2×good 窗口）
 *  F beat1.4 tap       重叠决胜：等距 |Δ| 时更早拍位 T2 赢
 *  J beat2  tap        恰好压线 perfect（闭区间边界，-50ms）
 *  J beat3  hold 2拍   跨小节长按，准点松手 → 尾拍 perfect
 *  F beat4  tap        准点踩
 *  F beat5  hold 1拍   长按中途释放（提前 0.25s 松手 → 尾拍 miss）
 *  J beat6  tap        慢一整拍：目标先自动 miss，补踩记 ignored
 *  F beat8  tap        晚 100ms → good；另含一次窗口内无板的乱按 ignored
 */
export const SAMPLE_TARGET_TEXT = `# 轨, 拍, 持续拍（0=踩一下）
F, 0, 0
F, 1, 0
F, 1.4, 0
J, 2, 0
J, 3, 2
F, 4, 0
F, 5, 1
J, 6, 0
F, 8, 0`;

export function buildSampleChart(): Chart {
  const specs = [
    { id: 'T1', lane: 'F', beat: 0, lengthBeats: 0 },
    { id: 'T2', lane: 'F', beat: 1, lengthBeats: 0 },
    { id: 'T3', lane: 'F', beat: 1.4, lengthBeats: 0 },
    { id: 'T4', lane: 'J', beat: 2, lengthBeats: 0 },
    { id: 'T5', lane: 'J', beat: 3, lengthBeats: 2 },
    { id: 'T6', lane: 'F', beat: 4, lengthBeats: 0 },
    { id: 'T7', lane: 'F', beat: 5, lengthBeats: 1 },
    { id: 'T8', lane: 'J', beat: 6, lengthBeats: 0 },
    { id: 'T9', lane: 'F', beat: 8, lengthBeats: 0 },
  ];
  return { config: { ...SAMPLE_CONFIG }, targets: specs.map((s) => ({ ...s })) };
}

/** 样例输入脚本（时间单位秒）。 */
export function buildSampleInputs(): InputEvent[] {
  const b = (beat: number) => beatToTime(beat, SAMPLE_CONFIG.bpm);
  return [
    // T1：早 20ms → perfect
    { t: b(0) - 0.02, kind: 'down', lane: 'F' },
    // T2/T3 重叠：0.60s 按下，距 T2(0.50) +100ms、距 T3(0.70) -100ms
    // 等距 → 更早拍位 T2 赢（good），T3 仍是候选并记录落选原因
    { t: b(1) + 0.1, kind: 'down', lane: 'F' },
    // T3 随后准点补踩 → perfect
    { t: b(1.4), kind: 'down', lane: 'F' },
    // T4：恰好 -50ms 压线 → perfect（闭区间）
    { t: b(2) - 0.05, kind: 'down', lane: 'J' },
    // T5 跨小节长按：beat3 准踩
    { t: b(3), kind: 'down', lane: 'J' },
    // T6：beat4 准踩
    { t: b(4), kind: 'down', lane: 'F' },
    // T7 长按中途释放：beat5 踩下，beat5.5 就松（尾拍 beat6，差 -0.25s → miss）
    { t: b(5), kind: 'down', lane: 'F' },
    { t: b(5.5), kind: 'up', lane: 'F' },
    // T5 在 beat5 准点松手 → 尾拍 perfect（跨小节 hold 完整结算）
    { t: b(5), kind: 'up', lane: 'J' },
    // T8 慢一整拍：beat7 才按，T8(beat6) 已自动 miss；窗口内无板 → ignored
    { t: b(7), kind: 'down', lane: 'J' },
    // 纯乱按：窗口内什么都没有 → ignored，不影响任何拍位
    { t: b(7.5), kind: 'down', lane: 'F' },
    // T9：晚 100ms → good
    { t: b(8) + 0.1, kind: 'down', lane: 'F' },
  ];
}

/** 三拍(3/4)预设，验证拍号切换与小节显示。 */
export const TRIPLE_CONFIG: ChartConfig = {
  bpm: 100,
  beatsPerMeasure: 3,
  measures: 4,
  perfectWindow: 0.06,
  goodWindow: 0.15,
};

export const TRIPLE_TARGET_TEXT = `# 3/4 预设
F, 0, 0
J, 1, 0
F, 3, 1.5
J, 5, 0
F, 7, 0`;

/**
 * 以固定步长（秒/帧）跑完一份输入脚本。
 * 帧长只决定 update 被切成几段，事件在队列里按绝对时刻等待，
 * 因此 60fps 与低帧率产出的判定流水必须逐行相同。
 * 起始时刻故意错开半帧，证明结果不依赖帧网格对齐。
 */
export function runReplay(
  chart: Chart,
  inputs: InputEvent[],
  frameStepSec: number,
  endTimeSec?: number,
): Engine {
  const engine = new Engine(chart);
  for (const e of inputs) engine.queueInput(e);
  const end =
    endTimeSec ??
    Math.max(
      ...chart.targets.map((t) => beatToTime(t.beat + t.lengthBeats, chart.config.bpm)),
      ...inputs.map((e) => e.t),
    ) + 1;
  for (let t = frameStepSec / 2; t <= end; t += frameStepSec) {
    engine.update(Math.min(t, end));
  }
  engine.update(end);
  return engine;
}

/** 把流水归一化成可逐行比较的 JSON（压掉浮点噪声，保留全部判定语义）。 */
export function normalizeLog(engine: Engine): unknown[] {
  return engine.log.map((r: JudgementRow) => ({
    t: Math.round(r.t * 1000) / 1000,
    source: r.source,
    kind: r.kind,
    lane: r.lane,
    targetId: r.targetId,
    grade: r.grade,
    deltaMs: r.deltaMs === null ? null : Math.round(r.deltaMs),
    candidates: (r.candidates ?? []).map((c) => ({
      targetId: c.targetId,
      sameLane: c.sameLane,
      won: c.won,
      reason: c.reason ?? null,
    })),
  }));
}

export function runtimeSnapshot(engine: Engine) {
  return engine.targets.map((t: RuntimeTarget) => ({
    id: t.id,
    state: t.state,
    grade: t.finalGrade,
  }));
}
