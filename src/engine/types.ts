// 引擎核心类型定义。纯数据，可被 JSON 深拷贝用于“重来”。

/** 屏幕坐标系方向（y 轴向下） */
export type Dir = 'N' | 'E' | 'S' | 'W';
export type RotDir = 'cw' | 'ccw';

export interface Vec2 {
  x: number;
  y: number;
}

/** 关卡定义中的端口（相对步道本地格坐标 + 本地朝外朝向） */
export interface PortDef {
  /** 端口所在格，相对步道左上角的偏移 */
  offset: Vec2;
  /** 本地朝外方向，随步道一起旋转 */
  dir: Dir;
}

export interface PlatformDef {
  id: 'A' | 'B';
  /** 3x3 步道左上角所在格 */
  origin: Vec2;
  /** 初始朝向（离散步数，0 = 初始；每转一次 90°） */
  orientation: number;
  /** 边长格数，本原型固定 3 */
  size: number;
  ports: PortDef[];
}

export type CellKind = 'wall' | 'floor' | 'rail' | 'pit';

export interface LevelDef {
  id: string;
  name: string;
  cols: number;
  rows: number;
  /** 除平台占位之外的格子：墙 / 地板 / 栏杆 / 空洞。未列出默认地板。 */
  cells: Partial<Record<CellKind, Vec2[]>>;
  platforms: PlatformDef[];
  /** 手柄格（固定在平台边外，本身是地板，可站立） */
  levers: Vec2[];
  spawn: Vec2;
  exit: Vec2;
}

export interface RuntimePort {
  platformId: 'A' | 'B';
  /** 端口所在格的世界坐标 */
  cell: Vec2;
  /** 当前世界中的朝外方向 */
  dir: Dir;
}

export interface Platform {
  id: 'A' | 'B';
  origin: Vec2;
  size: number;
  /** 离散朝向（0..3），动画结束后更新 */
  orientation: number;
  ports: PortDef[];
  /** 当前动画角度（弧度，顺时针为正）。停稳时为 0。 */
  animAngle: number;
  /** 动画目标角度（±PI/2），停稳时为 0 */
  animTarget: number;
  /** 本次动画的旋转方向 */
  animDir: RotDir | null;
}

export interface Player {
  cell: Vec2;
  /** 插值渲染用浮点世界坐标（格中心坐标，单位 = 格） */
  pos: Vec2;
  /** 正在乘坐的平台 id；在静态地面上为 null */
  aboard: 'A' | 'B' | null;
  /** 乘坐时相对平台枢轴的本地偏移（随平台旋转），不乘平台时为 null */
  localOffset: Vec2 | null;
  moveTimer: number;
}

export type BlockerKind = 'wall' | 'rail' | 'platform' | 'player';

export interface BlockerInfo {
  kind: BlockerKind;
  /** 栏杆 / 墙的格坐标；玩家为玩家所在格 */
  cell: Vec2;
  /** 发生接触时的转动角度（弧度） */
  atAngle: number;
  label: string;
}

export interface RotationPreview {
  platformId: 'A' | 'B';
  dir: RotDir;
  ok: boolean;
  blocker: BlockerInfo | null;
  /** 转动扫过的格（预览范围，含停稳位置） */
  sweptCells: Vec2[];
}

export type Phase = 'idle' | 'rotating' | 'won';

export interface GameState {
  /** 原始关卡定义，reset 时据此重建 */
  level: LevelDef;
  levelId: string;
  cols: number;
  rows: number;
  /** 静态格查表，key = x + ',' + y */
  grid: Map<string, CellKind>;
  platforms: Platform[];
  levers: Vec2[];
  spawn: Vec2;
  exit: Vec2;
  player: Player;
  phase: Phase;
  /** 当前/最近一次转动预览，用于绘制受影响范围 */
  preview: RotationPreview | null;
  /** 横幅提示文字（如被挡原因 / 通关） */
  banner: string;
  bannerTimer: number;
  showEdges: boolean;
}
