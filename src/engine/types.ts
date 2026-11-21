// 引擎核心类型定义。全部为可 JSON 序列化的普通数据，便于快照/回放。

export type Dir = 'up' | 'down' | 'left' | 'right';

export interface Pos {
  x: number;
  y: number;
}

export type ToolKind =
  | 'wall'
  | 'belt-up'
  | 'belt-down'
  | 'belt-left'
  | 'belt-right'
  | 'block1'
  | 'block2'
  | 'block3'
  | 'player'
  | 'tele-in'
  | 'tele-out'
  | 'eraser';

/** 传送门入口/出口，通过 pairId 两两配对 */
export interface TeleCell extends Pos {
  pairId: string;
  kind: 'in' | 'out';
}

export interface Block extends Pos {
  id: string;
  weight: 1 | 2 | 3;
}

export interface PlayerState extends Pos {}

export interface GameMap {
  w: number;
  h: number;
  /** "x,y" -> 墙 */
  walls: Record<string, true>;
  /** "x,y" -> 该格输送带方向 */
  belts: Record<string, Dir>;
  blocks: Block[];
  teles: TeleCell[];
  player: PlayerState;
}

export type EventKind =
  | 'player-move'
  | 'player-blocked'
  | 'block-push'
  | 'push-blocked'
  | 'belt-move'
  | 'belt-cancel'
  | 'teleport'
  | 'teleport-blocked';

export interface TickEvent {
  kind: EventKind;
  /** 受影响对象 id：方块用 block:<id>，玩家用 player，格位用 cell:x,y */
  subject: string;
  detail: string;
  from?: Pos;
  to?: Pos;
  /** 结算阶段，便于在事件面板里分组 */
  phase: 'player' | 'teleport-1' | 'belt' | 'teleport-2';
}

export type Input = Dir | 'idle';

export interface GameState {
  map: GameMap;
  tick: number;
  /** 本拍事件（step 后由引擎填充，下一拍清空） */
  events: TickEvent[];
  rngState: number;
}

/** 玩家推力：整排方块总重量不超过该值才能推动 */
export const PLAYER_PUSH_FORCE = 3;
/** 输送带力：重量超过该值的方块输送带推不动（直接取消并标记） */
export const BELT_FORCE = 2;

export const key = (x: number, y: number): string => `${x},${y}`;
export const posKey = (p: Pos): string => `${p.x},${p.y}`;

export const DIR_VEC: Record<Dir, Pos> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export const DIR_LABEL: Record<Dir, string> = {
  up: '上',
  down: '下',
  left: '左',
  right: '右',
};

export const addPos = (p: Pos, d: Dir): Pos => ({
  x: p.x + DIR_VEC[d].x,
  y: p.y + DIR_VEC[d].y,
});

export const samePos = (a: Pos, b: Pos): boolean => a.x === b.x && a.y === b.y;
