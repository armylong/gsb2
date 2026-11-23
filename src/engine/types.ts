// 纯逻辑层共享类型。此文件不依赖 DOM / 音频，可在 node 下直接单测。

/** 判定等级。IGNORED 表示这次输入没匹配到任何板（按多了）。 */
export type Grade = 'perfect' | 'good' | 'miss' | 'ignored';

/** 输入方向。 */
export type InputKind = 'down' | 'up';

/** 地板轨 id：由拍位文本里给的名字决定，例如 'F' / 'J'。 */
export type LaneId = string;

/** 谱面全局参数与窗口（秒）。 */
export interface ChartConfig {
  /** 每分钟拍数（拍 = 一个节拍单位，不是小节）。 */
  bpm: number;
  /** 每小节拍数：4 = 四拍(4/4)，3 = 三拍(3/4)。 */
  beatsPerMeasure: 3 | 4;
  /** 小节数（预览/练习范围）。 */
  measures: number;
  /** |Δ| <= perfectWindow → perfect（闭区间，压线归这一档）。 */
  perfectWindow: number;
  /** |Δ| <= goodWindow → good（闭区间）；再大且已过窗口 → miss。 */
  goodWindow: number;
}

/** 一块地板的排谱定义。 */
export interface TargetSpec {
  id: string;
  lane: LaneId;
  /** 起始拍（可为小数，0 = 第 1 小节第 1 拍）。 */
  beat: number;
  /** 持续拍数：0 表示踩一下(tap)，>0 表示按住(hold)，可跨小节。 */
  lengthBeats: number;
}

export interface Chart {
  config: ChartConfig;
  targets: TargetSpec[];
}

/** 一次物理输入（真人事件或重放脚本里的事件同构）。 */
export interface InputEvent {
  /** 歌曲时间轴上的时刻（秒），与帧率无关。 */
  t: number;
  kind: InputKind;
  lane: LaneId;
}

/** 每个目标在运行时的状态。 */
export type TargetState = 'pending' | 'held' | 'done';

export interface RuntimeTarget extends TargetSpec {
  state: TargetState;
  /** 头拍结算后的等级，尾拍结算会被 finalGrade 覆盖。 */
  finalGrade: Grade | null;
  /** 最近一次结算的毫秒误差（带符号，负=早 正=晚）。 */
  lastDeltaMs: number | null;
}

/** 一条判定流水（“按多了”的输入也会留 ignored 记录）。 */
export interface JudgementRow {
  /** 单调序号，便于核对处理顺序。 */
  seq: number;
  /** 输入时刻（秒）；自动 miss 行等于目标时刻/尾拍时刻。 */
  t: number;
  /** 触发来源：input=真实输入，auto=引擎自动结算（超时 miss / 尾拍自动收），seek/pause=控制操作。 */
  source: 'input' | 'auto' | 'pause' | 'seek';
  kind: InputKind | 'head' | 'tail';
  lane: LaneId;
  targetId: string | null;
  grade: Grade;
  /** 毫秒误差（带符号）。ignored / 自动 miss 为 null。 */
  deltaMs: number | null;
  /** 本次输入看到的窗口内候选（含异轨，用于复盘“为什么给了它”）。 */
  candidates?: CandidateInfo[];
  /** 候选之外的说明文字。 */
  note?: string;
}

export interface CandidateInfo {
  targetId: string;
  lane: LaneId;
  /** 这次候选要结算的是头拍还是尾拍。 */
  part: 'head' | 'tail';
  /** 候选目标时刻（秒）。 */
  at: number;
  /** 输入与该时刻的毫秒差（带符号）。 */
  deltaMs: number;
  /** 与输入是否同轨（异轨只能围观，不能被这次输入拿走）。 */
  sameLane: boolean;
  /** 是否实际赢得这次输入。 */
  won: boolean;
  /** 落选原因（赢家没有该字段）。 */
  reason?: string;
}

/** 成绩汇总。ignored 不进分母，不影响其他拍位。 */
export interface ScoreSummary {
  perfect: number;
  good: number;
  miss: number;
  ignored: number;
  /** 满分条目数 = 每个 tap 1 条、每个 hold 2 条。 */
  total: number;
  /** 命中准确率（perfect+good）/ total。 */
  accuracy: number;
}
