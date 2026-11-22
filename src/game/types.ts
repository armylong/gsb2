export const CATEGORY_ORDER = ['陶器', '玉器', '骨器', '简牍'] as const;
export type Category = (typeof CATEGORY_ORDER)[number];

export type TeamId = 'red' | 'blue' | 'gold';
export const TEAM_IDS: readonly TeamId[] = ['red', 'blue', 'gold'];

export type TeamControl = 'manual' | 'auto';
export type AutoStrategy = 'set' | 'value';
export type Viewer = TeamId | 'observer';

export interface Specimen {
  id: string;
  name: string;
  /** 单字标记，纯文字标本的视觉索引。 */
  glyph: string;
  category: Category;
  value: number;
  note: string;
}

export interface Team {
  id: TeamId;
  name: string;
  sigil: string;
  color: string;
  control: TeamControl;
  strategy: AutoStrategy;
}

export type Phase = 'selecting' | 'opened';

export interface Selection {
  primary: string | null;
  backup: string | null;
  confirmed: boolean;
  source: 'manual' | 'auto';
}

export interface DemoPick {
  primary: string;
  backup: string | null;
}

export interface ScenarioRound {
  title: string;
  brief: string;
  table: Specimen[];
  /** 演示脚本：套用后可在对应回合触发指定裁定。 */
  recommendations?: Partial<Record<TeamId, DemoPick>>;
}

export interface TeamSetup {
  control: TeamControl;
  strategy: AutoStrategy;
}

export interface Scenario {
  id: string;
  name: string;
  tagline: string;
  description: string;
  highlights: string[];
  seed: number;
  rounds: ScenarioRound[];
  teamSetups?: Partial<Record<TeamId, Partial<TeamSetup>>>;
}

export interface Choice {
  primary: string | null;
  backup: string | null;
}

export interface Assignment {
  teamId: TeamId;
  specimenId: string;
  via: 'primary' | 'backup';
  /** 本次开牌中的授予次序，从 1 开始。 */
  order: number;
}

export type MissReason = 'no-backup' | 'backup-taken';

export interface MissRecord {
  teamId: TeamId;
  primaryId: string | null;
  backupId: string | null;
  reason: MissReason;
  primaryTakenBy?: TeamId;
  backupTakenBy?: TeamId;
}

export interface TraceEvent {
  pass: 'primary' | 'backup';
  teamId: TeamId;
  specimenId: string | null;
  outcome: 'granted' | 'taken' | 'no-request';
  takenBy?: TeamId;
}

export interface RoundResult {
  roundIndex: number;
  priority: TeamId[];
  table: Specimen[];
  choices: Record<TeamId, Choice>;
  assignments: Assignment[];
  misses: MissRecord[];
  trace: TraceEvent[];
}

export interface GameState {
  version: 1;
  scenarioId: string;
  scenarioName: string;
  scenarioTagline: string;
  seed: number;
  roundIndex: number;
  phase: Phase;
  teams: Team[];
  rounds: ScenarioRound[];
  selections: Record<TeamId, Selection>;
  history: RoundResult[];
  createdAt: string;
  updatedAt: string;
}

export type SetTier = 'none' | 'pair' | 'triad' | 'quad';

export interface CategoryBreakdown {
  category: Category;
  itemIds: string[];
  count: number;
  tier: SetTier;
  perItemBonus: number;
  totalBonus: number;
}

export interface ItemScoreLine {
  specimenId: string;
  name: string;
  glyph: string;
  category: Category;
  base: number;
  setBonus: number;
  total: number;
  acquiredRound: number;
  via: 'primary' | 'backup';
  reasons: string[];
}

export interface TeamScore {
  teamId: TeamId;
  count: number;
  baseTotal: number;
  setBonusTotal: number;
  total: number;
  categories: CategoryBreakdown[];
  items: ItemScoreLine[];
}

export interface Standings {
  scores: TeamScore[];
  topScore: number;
  tiedTeamIds: TeamId[];
  isTie: boolean;
  roundsPlayed: number;
}

export interface SaveFile {
  version: 1;
  id: string;
  label: string;
  savedAt: string;
  viewTeam: Viewer;
  game: GameState;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
