export type CompareOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

export type Condition =
  | { kind: 'flag'; key: string; value: boolean }
  | { kind: 'stat'; key: string; op: CompareOp; value: number }
  | { kind: 'item'; key: string; op: CompareOp; value: number }
  | { kind: 'group'; mode: 'all' | 'any'; conditions: Condition[] };

export type Effect =
  | { kind: 'flag'; key: string; value: boolean }
  | { kind: 'stat'; key: string; delta: number }
  | { kind: 'item'; key: string; delta: number };

export interface FlagDefinition {
  key: string;
  label: string;
  initial: boolean;
}

export interface NumberDefinition {
  key: string;
  label: string;
  initial: number;
}

export interface VariableCatalog {
  flags: FlagDefinition[];
  stats: NumberDefinition[];
  items: NumberDefinition[];
}

export interface DialogueChoice {
  id: string;
  label: string;
  target: string;
  when?: Condition;
  effects: Effect[];
  /** 玩家视图中不可用时是禁用还是隐藏；调试视图始终列出并解释原因。 */
  lockedDisplay: 'disable' | 'hide';
}

export interface DialogueNode {
  id: string;
  title: string;
  speaker: string;
  text: string;
  terminal: boolean;
  choices: DialogueChoice[];
  /** 关系图的固定网格位置；缺省时由布局函数补位。 */
  position?: { col: number; row: number };
}

export interface DialogueConfig {
  schemaVersion: 1;
  id: string;
  title: string;
  subtitle: string;
  entryNodeId: string;
  variables: VariableCatalog;
  nodes: DialogueNode[];
}

export interface GameState {
  flags: Record<string, boolean>;
  stats: Record<string, number>;
  items: Record<string, number>;
}

export interface LockReason {
  kind: 'condition' | 'item-cost' | 'missing-target';
  text: string;
}

export interface ChoiceAvailability {
  available: boolean;
  reasons: LockReason[];
}

export interface ChoiceView {
  choice: DialogueChoice;
  available: boolean;
  reasons: LockReason[];
  visible: boolean;
}

export interface HistoryEntry {
  seq: number;
  nodeId: string;
  nodeTitle: string;
  choiceId: string;
  choiceLabel: string;
  targetNodeId: string;
  targetNodeTitle: string;
  before: GameState;
  after: GameState;
}

export interface AbandonedBranch {
  id: string;
  label: string;
  entries: HistoryEntry[];
  finalNodeId: string;
  finalNodeTitle: string;
  finalState: GameState;
}

export interface RunState {
  nodeId: string;
  state: GameState;
  history: HistoryEntry[];
  abandonedBranches: AbandonedBranch[];
  nextSeq: number;
}

export type ValidationIssueKind =
  | 'missing-entry'
  | 'duplicate-node'
  | 'duplicate-choice'
  | 'missing-target'
  | 'dead-end'
  | 'unreachable'
  | 'no-unconditional-exit'
  | 'no-path-to-ending'
  | 'no-reachable-ending'
  | 'terminal-with-choices'
  | 'unknown-variable'
  | 'invalid-effect'
  | 'empty-label';

export interface ValidationIssue {
  kind: ValidationIssueKind;
  severity: 'error' | 'warning';
  message: string;
  nodeId?: string;
  choiceId?: string;
}

export interface ValidationReport {
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  missingTargets: { nodeId: string; choiceId: string; target: string }[];
  deadEnds: string[];
  unreachableNodeIds: string[];
  noUnconditionalExitNodeIds: string[];
  noPathToEndingNodeIds: string[];
  loopNodeIds: string[];
  reachableEndingIds: string[];
}

export interface SaveSnapshot {
  nodeId: string;
  state: GameState;
  history: HistoryEntry[];
  abandonedBranches: AbandonedBranch[];
  nextSeq: number;
}

export interface SaveRecord {
  version: 1;
  id: string;
  name: string;
  savedAt: string;
  configFingerprint: string;
  snapshot: SaveSnapshot;
}

export interface CompatibilityResult {
  ok: boolean;
  configChanged: boolean;
  problems: string[];
  warnings: string[];
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
