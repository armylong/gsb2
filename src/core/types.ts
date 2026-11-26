/**
 * 核心数据模型。
 *
 * 全局位置一律用「四分音符拍数」(quarter position, 记作 q) 做坐标:
 * 无论拍号怎么变、是否弱起、是否渐快, 每个拍点和小节边界都有唯一的 q。
 * 秒数完全由时间线 (tempo segments) 从 q 推导, 所以改速度后小节位置不变、秒数重算。
 */

export type VoiceName = 'downbeat' | 'beat' | 'sub';

/** 音色: 正弦衰减 / 三角衰减 / 滤波短噪声 (类似木鱼) */
export type TimbreName = 'sine' | 'triangle' | 'noise';

export interface VoiceSettings {
  /** 0..1, 播放中改它只影响之后要响的拍, 不会重排已响的拍 */
  volume: number;
  timbre: TimbreName;
  /** Hz, 该音色的基频/中心频率 */
  pitch: number;
}

export interface PlaySettings {
  voices: Record<VoiceName, VoiceSettings>;
  /** 试听时是否同时输出分拍; 导出跟随此设置, 保证试听与导出一致 */
  playSubdivisions: boolean;
}

/** 拍号, 例如 4/4 => numerator=4, denominator=4, 每小节 4 个四分音符 */
export interface Meter {
  numerator: number;
  denominator: number;
}

export type TempoMode = 'constant' | 'ramp';

export interface Segment {
  id: string;
  meter: Meter;
  /** 段内小节数; 弱起段 = 1 个不完整小节, beats 存实际拍数 */
  bars: number;
  /** 弱起 (anacrusis): 该段第一小节只含 beats 个四分音符; 仅对段首有效 */
  pickupBeats: number;
  /** 每拍拆成几个分拍 (2=八分, 3=三连音, 4=十六分); 1=不分 */
  subdivision: number;
  mode: TempoMode;
  /** constant: 恒定速度; ramp: 起始 BPM */
  bpmStart: number;
  /** ramp: 结束 BPM; constant 时忽略 */
  bpmEnd: number;
  label: string;
}

export interface Project {
  segments: Segment[];
  settings: PlaySettings;
}

/** 一个小节 (弱起小节的 quarters < meter 满小节长度) */
export interface BarInfo {
  index: number;
  segmentId: string;
  segmentIndex: number;
  /** 显示用小节号: 满小节从 1 递增, 弱起显示 "0(弱起)" */
  barNumber: number;
  isPickup: boolean;
  qStart: number;
  qEnd: number;
  /** 该小节的四分音符数 */
  quarters: number;
  meter: Meter;
}

export type ClickKind = 'downbeat' | 'beat' | 'sub';

/** 时间线上一个发声点 (或纯位置点) */
export interface ClickEvent {
  /** 全局四分音符坐标, 唯一 */
  q: number;
  t: number;
  kind: ClickKind;
  segmentId: string;
  barIndex: number;
  /** 小节内第几拍, 从 1 开始; 分拍为小数, 如 1.5 */
  beatInBar: number;
  /** 是否同时是某段的首拍 */
  isSegmentStart: boolean;
  /** 弱起小节内的拍 */
  isPickup: boolean;
  /** 所属拍点 (分拍归属的整拍 q), 整拍时等于 q */
  parentBeatQ: number;
}

export interface Marker {
  q: number;
  t: number;
  label: string;
  kind: 'zero' | 'segment-start' | 'last-beat' | 'selection-end' | 'count-in';
}
