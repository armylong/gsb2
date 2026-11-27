/** 池边巡护 —— 纯逻辑层类型。这里不碰 canvas / DOM，全部可被 Node 直接跑。 */

/** 整数格坐标。地图以「格」为单位，渲染时再换算成像素。 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 连续坐标，用于水道路径（1 = 一格）。 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

export type LocationKind = 'island' | 'lawn';

export interface LocationDef {
  readonly id: string;
  readonly name: string;
  readonly kind: LocationKind;
  readonly rect: Rect;
  /** 岛上动物的默认站位（连续坐标，默认是矩形中心）。 */
  readonly anchor?: Point;
}

export type Species = 'turtle' | 'duck' | 'carp' | 'frog';

export interface AnimalDef {
  readonly id: string;
  readonly number: number;
  readonly name: string;
  readonly species: Species;
  readonly color: string;
  readonly ink: string;
}

export interface ChannelDef {
  readonly from: string;
  readonly to: string;
  /** 水道的绘制折线（连续坐标），最后一段指向下游。 */
  readonly points: readonly Point[];
}

export interface Board {
  readonly cols: number;
  readonly rows: number;
  readonly locations: readonly LocationDef[];
  readonly animals: readonly AnimalDef[];
  /** 每个地点的唯一下游出口；草坪为 null。 */
  readonly outlets: Readonly<Record<string, string | null>>;
  /** 水道。每条都是单向的。 */
  readonly channels: readonly ChannelDef[];
  /** 岛 → 相邻草坪。岛的下游被占时，动物可以退到这里。 */
  readonly grassFrom: Readonly<Record<string, string>>;
}

/** 状态：动物 id → 所在地点 id。同一地点至多一只。 */
export type State = Readonly<Record<string, string>>;

/**
 * 一回合的「记录」：只能从状态变化里看出来，不写是谁。
 * - island：有动物从一座岛换到了另一座岛；
 * - lawn：有动物到了草坪（可能直接游过来，也可能被堵后从岛边退过来）；
 * - wait：有动物停在原地没动。
 */
export type EventType = 'island' | 'lawn' | 'wait';

/** 一步动作的真实机制。 */
export type MoveKind = 'swim' | 'grass' | 'wait';

/** 一次正向动作。 */
export interface MoveResult {
  readonly actor: string;
  readonly from: string;
  readonly to: string;
  readonly kind: MoveKind;
  /** 被谁占了出口（grass / wait 时有值）。 */
  readonly blockerId?: string;
  /** 规则说明，直接用于事件卡。 */
  readonly note: string;
}

export interface StartClue {
  readonly text: string;
  /** 清晨必须空着的地点。 */
  readonly emptyLocations?: readonly string[];
  /** 清晨某只动物必须所在的地点。 */
  readonly fixed?: Readonly<Record<string, string>>;
}

export type PuzzleMode = 'tutorial' | 'reverse';

export interface TutorialGoal {
  readonly text: string;
  /** 达成条件：某只动物出现在某地点。 */
  readonly animalId: string;
  readonly locationId: string;
}

export interface Puzzle {
  readonly id: string;
  readonly mode: PuzzleMode;
  readonly board: Board;
  readonly title: string;
  readonly subtitle: string;
  readonly intro: string;
  readonly coda: string;
  /** 终态。反推起点；教学盘里是演示终点。 */
  readonly finalState: State;
  /** 每回合的记录类型，turn i 对应 round i+1。 */
  readonly events: readonly EventType[];
  /** 正式关的早晨线索。 */
  readonly clue?: StartClue;
  /** 教学盘：清晨起始盘。 */
  readonly startState?: State;
  /** 教学盘的三个小目标。 */
  readonly goals?: readonly TutorialGoal[];
  /** 设计上的标准答案（用于自检，不在正题里剧透）。 */
  readonly expectedStart?: State;
}
