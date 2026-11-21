import { doorIndex, idx, isWalkable } from './grid';
import type { GameMap, RouteStep } from './types';
import { colorName } from './types';

export interface MoveResult {
  ok: boolean;
  /** 移动失败原因(成功为 null) */
  blockedReason: string | null;
  /** 本步打开的门 id */
  openedDoorId: number | null;
  /** 本步拾取的钥匙 id */
  pickedKeyId: number | null;
}

/**
 * 玩家状态机:逐步走路线与手动方向键共用。
 * 钥匙取得后永久持有、不消耗;同色门共用钥匙;已打开的门永久敞开。
 */
export class Player {
  x: number;
  y: number;
  readonly heldColors = new Set<number>();
  readonly openedDoorIds = new Set<number>();
  readonly pickedKeyIds = new Set<number>();
  /** 实际走过的每一步(含起点第 0 步) */
  readonly history: RouteStep[] = [];
  private readonly doorAt: Map<number, number>;

  constructor(private readonly map: GameMap) {
    this.x = map.start.x;
    this.y = map.start.y;
    this.doorAt = doorIndex(map);
    const pickedKeyId = this.collectAtCurrent();
    this.history.push({
      index: 0,
      x: this.x,
      y: this.y,
      openedDoorId: null,
      pickedKeyId,
      heldColors: [...this.heldColors].sort((a, b) => a - b),
      openedDoorIds: [],
    });
  }

  private collectAtCurrent(): number | null {
    let picked: number | null = null;
    for (const k of this.map.keys) {
      if (k.x === this.x && k.y === this.y && !this.pickedKeyIds.has(k.id)) {
        this.pickedKeyIds.add(k.id);
        this.heldColors.add(k.color);
        picked = k.id;
      }
    }
    return picked;
  }

  /** 尝试移动到相邻格;过门规则与分析器完全一致 */
  move(dx: number, dy: number): MoveResult {
    const nx = this.x + dx;
    const ny = this.y + dy;
    if (!isWalkable(this.map, nx, ny)) {
      return { ok: false, blockedReason: `(${nx},${ny}) 是墙或地图边界,无法进入`, openedDoorId: null, pickedKeyId: null };
    }
    const doorId = this.doorAt.get(idx(nx, ny, this.map.width));
    let openedDoorId: number | null = null;
    if (doorId !== undefined) {
      const door = this.map.doors[doorId];
      if (door.color !== null && !this.heldColors.has(door.color)) {
        return {
          ok: false,
          blockedReason: `门上了${colorName(door.color)}色锁,你还没有${colorName(door.color)}色钥匙`,
          openedDoorId: null,
          pickedKeyId: null,
        };
      }
      if (!this.openedDoorIds.has(door.id)) {
        this.openedDoorIds.add(door.id);
        openedDoorId = door.id;
      }
    }
    this.x = nx;
    this.y = ny;
    const pickedKeyId = this.collectAtCurrent();
    this.history.push({
      index: this.history.length,
      x: nx,
      y: ny,
      openedDoorId,
      pickedKeyId,
      heldColors: [...this.heldColors].sort((a, b) => a - b),
      openedDoorIds: [...this.openedDoorIds].sort((a, b) => a - b),
    });
    return { ok: true, blockedReason: null, openedDoorId, pickedKeyId };
  }

  get atExit(): boolean {
    return this.x === this.map.exit.x && this.y === this.map.exit.y;
  }

  get stepCount(): number {
    return this.history.length - 1;
  }
}
