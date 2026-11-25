// 核心领域类型：铃片、音高带、敲击条件、题目与存档结构。

export type PlateId = 'cang' | 'qing' | 'shang' | 'fu' | 'quan' | 'sui';

/** 粗粒度音高带：音高极近的 shang/fu 共享 Dn，混合声纹层面不区分二者。 */
export type BandId = 'G' | 'C' | 'Dn' | 'E' | 'E6';

export type Position = 0 | 1 | 2;

/** 一次敲击方式：全响，或压住某个位置后敲响。 */
export type StrikeKind = { type: 'all' } | { type: 'mute'; pos: Position };

export type ConditionKey = 'all' | 'm0' | 'm1' | 'm2';

export interface PartialDef {
  ratio: number;
  gain: number;
  /** 相对于铃片主余音时长的衰减倍率，越小消失越快 */
  decayFactor: number;
  type?: OscillatorType;
  detune?: number;
}

export interface PlateDef {
  id: PlateId;
  name: string;
  subtitle: string;
  pitchLabel: string;
  freq: number;
  band: BandId;
  bandLabel: string;
  /** 主余音持续秒数（程序合成的指数衰减到达听不见的近似时长） */
  decay: number;
  decayWord: '短促' | '中等' | '悠长' | '极长';
  partials: PartialDef[];
  /** 敲槌噪声瞬态 */
  mallet: { gain: number; freq: number; q: number; dur: number };
  color: string;
  colorSoft: string;
  /** 试听栏里展示的学习要点 */
  learn: string;
  /** 唯一细指纹：全响/压制 A-B 对比后可提取，形式上唯一锁定一片 */
  fineCode: string;
}

export interface PuzzleDef {
  id: string;
  index: number;
  groupName: string;
  title: string;
  difficulty: 'easy' | 'ambiguous';
  tagline: string;
  /** 真实摆放：三个位置（左 / 中 / 右）上的铃片，固定题，不随机 */
  truth: [PlateId, PlateId, PlateId];
  /** 本题可用于新敲击的次数；回放已保留的记录不消耗次数 */
  budget: number;
  briefing: string;
  /** 结束核对时的鉴别讲解 */
  debrief: {
    closePair?: string;
    overlap?: string;
    decisive: string;
  };
}

export interface StrikeAnalysis {
  /** 按声像位置检出的粗音高带 */
  bandsByPos: [BandId, BandId, BandId];
}

export interface StrikeRecord {
  id: string;
  kind: StrikeKind;
  key: ConditionKey;
  at: number;
  analysis: StrikeAnalysis;
}

export type Phase = 'playing' | 'submitted';

export interface SubmitResult {
  correct: boolean;
  /** 玩家未提交答案，选择直接核对真相 */
  gaveUp?: boolean;
  /** 提交瞬间，严格声纹证据等价的组合数 */
  evidenceCompatibleCount: number;
  /** 提交瞬间证据是否已唯一（且所选即唯一解） */
  evidenceUnique: boolean;
  at: number;
}

export interface PuzzleProgress {
  puzzleId: string;
  records: StrikeRecord[];
  /** 已完成 全响↔压P A/B 对比的位置，值为提取出的细指纹 */
  fineCodes: Partial<Record<Position, string>>;
  /** 玩家手动排除的组合 id */
  excluded: string[];
  /** 玩家选中的组合 id */
  selected: string | null;
  phase: Phase;
  result: SubmitResult | null;
  updatedAt: number;
}

export interface PersistState {
  version: 1;
  currentPuzzleId: string;
  puzzles: Record<string, PuzzleProgress>;
}
