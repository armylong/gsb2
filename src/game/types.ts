// 标本轮选 —— 核心类型定义（纯数据，无 DOM / React 依赖）

export type CategoryId = 'rock' | 'insect' | 'plant';

export interface CategoryDef {
  id: CategoryId;
  label: string;
  /** 集齐多少件算一套 */
  setSize: number;
  /** 每凑成一套额外加分 */
  setBonus: number;
}

export interface Specimen {
  id: string;
  label: string;
  category: CategoryId;
  /** 单件基础分 */
  value: number;
}

export type TeamId = 'A' | 'B' | 'C';

export type AutoStrategy = 'valueFirst' | 'setSeeker' | null;

export interface TeamDef {
  id: TeamId;
  label: string;
  autoStrategy: AutoStrategy;
  color: string;
}

/** 空手原因：没抢到的也要有记录，并能区分两种情况 */
export type MissReason =
  | 'noBackup' // 没有合适备选（本队根本没提交备用）
  | 'backupTaken'; // 备选已被别人拿走

export type OutcomeStatus =
  | 'primaryWon' // 首选到手
  | 'backupWon' // 首选撞选落败，备用到手
  | 'missedNoBackup' // 首选落败，且没有备选
  | 'missedBackupTaken'; // 首选落败，备选也被分走

export interface PickLog {
  teamId: TeamId;
  priorityIndex: number; // 本轮优先顺序中的位置（0 = 最优先）
  primaryId: string | null;
  backupId: string | null;
  outcome: OutcomeStatus;
  wonSpecimenId: string | null;
  missReason: MissReason | null;
  /** 首选被谁抢走（按优先顺序处理时占用的队），用于开牌来由 */
  primaryTakenBy: TeamId | null;
  /** 备用被谁抢走 */
  backupTakenBy: TeamId | null;
}

export interface TeamChoices {
  primaryId: string | null;
  backupId: string | null;
  confirmed: boolean;
}

export interface RoundState {
  index: number; // 从 0 开始
  specimens: Specimen[];
  /** 本轮优先顺序（队 id 序列，每轮整体左旋一位） */
  priority: TeamId[];
  choices: Record<TeamId, TeamChoices>;
  log: PickLog[] | null; // 开牌后才有
  allocations: Record<TeamId, string | null> | null;
}

export interface GameConfig {
  totalRounds: number;
  seed: number;
}

export type ScenarioId =
  | 'sandbox'
  | 'collisionPrimary'
  | 'collisionBackup'
  | 'tieScore';

export interface RoundSetup {
  specimens: Specimen[];
  /** 预置选择（内置回合用）；缺省的队由自动策略或手动补 */
  presets?: Partial<Record<TeamId, TeamChoices>>;
}

export interface ScenarioDef {
  id: ScenarioId;
  label: string;
  description: string;
  totalRounds: number;
  seed: number;
  rounds: RoundSetup[];
}

export interface GameState {
  version: number;
  scenarioId: ScenarioId;
  seed: number;
  teams: TeamDef[];
  categories: Record<CategoryId, CategoryDef>;
  rounds: RoundState[];
  currentRound: number;
  /** 已开牌轮次的指纹（种子+选择 -> 结果），用于验证可重复性 */
  fingerprint: string | null;
}
