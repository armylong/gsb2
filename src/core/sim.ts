import { ActionId, SceneId } from './bindings';

/**
 * 确定性模拟：固定步长（1 tick = 1/60s 逻辑时间），无随机数、无浮点累计误差源。
 * 同样的输入事件序列必然得到同样的状态序列，这是录制/回放校验的基础。
 */

export const ARENA_W = 480;
export const ARENA_H = 360;
export const MOVE_SPEED = 3;
export const DASH_SPEED = 12;
export const DASH_TICKS = 8;
export const MENU_ITEMS = ['继续游戏', '读取录像', '键位设置', '退出'];
const MENU_COOLDOWN = 10;

export interface SimState {
  tick: number;
  x: number;
  y: number;
  dirX: number;
  dirY: number;
  dashTicks: number;
  dashDX: number;
  dashDY: number;
  interactCount: number;
  confirmCount: number;
  paused: boolean;
  scene: SceneId;
  menuIndex: number;
  menuCooldown: number;
}

export function initialSimState(scene: SceneId = 'game'): SimState {
  return {
    tick: 0,
    x: ARENA_W / 2,
    y: ARENA_H / 2,
    dirX: 1,
    dirY: 0,
    dashTicks: 0,
    dashDX: 0,
    dashDY: 0,
    interactCount: 0,
    confirmCount: 0,
    paused: false,
    scene,
    menuIndex: 0,
    menuCooldown: 0,
  };
}

export class Simulation {
  state: SimState;
  private continuous = new Set<ActionId>();
  private edgeQueue: ActionId[] = [];

  constructor(initial?: Partial<SimState>) {
    this.state = { ...initialSimState(), ...initial };
  }

  reset(initial?: Partial<SimState>) {
    this.state = { ...initialSimState(), ...initial };
    this.continuous.clear();
    this.edgeQueue.length = 0;
  }

  actionDown(a: ActionId) {
    this.continuous.add(a);
  }

  actionUp(a: ActionId) {
    this.continuous.delete(a);
  }

  fireEdge(a: ActionId) {
    this.edgeQueue.push(a);
  }

  /** 释放全部持续动作（失焦/暂停/场景切换时由 World 调用） */
  releaseAll() {
    this.continuous.clear();
  }

  getContinuous(): ReadonlySet<ActionId> {
    return this.continuous;
  }

  step() {
    const s = this.state;
    for (const a of this.edgeQueue) {
      if (a === 'pause') {
        if (s.scene === 'game') s.paused = !s.paused;
      } else if (!s.paused) {
        if (a === 'dash' && s.scene === 'game' && s.dashTicks === 0) {
          s.dashTicks = DASH_TICKS;
          s.dashDX = s.dirX;
          s.dashDY = s.dirY;
        } else if (a === 'interact') {
          if (s.scene === 'game') s.interactCount++;
          else s.confirmCount++;
        }
      }
    }
    this.edgeQueue.length = 0;

    if (!s.paused) {
      let mx = 0;
      let my = 0;
      if (this.continuous.has('moveLeft')) mx -= 1;
      if (this.continuous.has('moveRight')) mx += 1;
      if (this.continuous.has('moveUp')) my -= 1;
      if (this.continuous.has('moveDown')) my += 1;
      if (mx !== 0 || my !== 0) {
        const len = Math.sqrt(mx * mx + my * my);
        s.dirX = mx / len;
        s.dirY = my / len;
      }
      if (s.scene === 'game') {
        let vx = 0;
        let vy = 0;
        if (s.dashTicks > 0) {
          vx = s.dashDX * DASH_SPEED;
          vy = s.dashDY * DASH_SPEED;
          s.dashTicks--;
        } else if (mx !== 0 || my !== 0) {
          vx = s.dirX * MOVE_SPEED;
          vy = s.dirY * MOVE_SPEED;
        }
        s.x = Math.min(ARENA_W - 10, Math.max(10, s.x + vx));
        s.y = Math.min(ARENA_H - 10, Math.max(10, s.y + vy));
      } else {
        // 菜单场景：上下移动以固定节奏移动光标（确定性）
        if (s.menuCooldown > 0) s.menuCooldown--;
        if (my !== 0 && s.menuCooldown === 0) {
          s.menuIndex = (s.menuIndex + my + MENU_ITEMS.length) % MENU_ITEMS.length;
          s.menuCooldown = MENU_COOLDOWN;
        }
      }
    }
    s.tick++;
  }
}
