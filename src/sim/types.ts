// 基础类型定义:仿真核心不依赖 DOM,便于在 Node 中回放样例做验证

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 平台/障碍碰撞体。grabbable=true 时其顶部左右两角为可抓边缘 */
export interface Platform extends Rect {
  id: string;
  grabbable: boolean;
}

/** 角色动作状态机 */
export type CharState =
  | 'ground'     // 站立(有支撑)
  | 'air'        // 空中(无支撑)
  | 'wallslide'  // 贴墙滑落
  | 'ledge'      // 抓住边缘悬挂
  | 'mantle';    // 翻身登上平台的过程中

/** 抓住的具体边缘:某个平台的某个顶角 */
export interface LedgeRef {
  platId: string;
  side: 'left' | 'right'; // 平台顶部的左角 / 右角
}

export interface Input {
  left: boolean;
  right: boolean;
  jump: boolean;
  down: boolean;
  jumpPressed: boolean; // 本帧刚按下跳(边沿触发)
}

export interface Character {
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  state: CharState;
  ledge: LedgeRef | null;
  grabCooldown: number;        // 松手后短时间内禁止重新抓边
  impulseT: number;            // 蹬墙跳水平冲量剩余时间
  impulseVx: number;
  mantleT: number;             // 翻身进度 0..1
  mantleFrom: { x: number; y: number };
  mantleTo: { x: number; y: number };
  mantleBlockedFlash: number;  // 低顶阻挡提示计时(>0 时 HUD 提示)
}

export interface World {
  platforms: Platform[];
  spawn: { x: number; y: number };
}
