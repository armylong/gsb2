/**
 * 寻路模拟层: 纯 TypeScript, 不依赖 Canvas/DOM, 便于自动化验证。
 *
 * 职责:
 *  - 维护障碍(含两扇挡门的开合)、角色半径、起终点与当前位置;
 *  - 通路变化(拖动障碍/开关门/改半径)后重建导航网格并重新寻路;
 *  - 状态机覆盖: 就绪、行进中、到达、不可达、起终点非法、角色被障碍占住;
 *  - 统计重新寻路次数与剩余路程; 恢复布局时连同角色位置一起复原。
 */
import { Vec2, Rect, EPS, polylineLength, dist } from './geometry';
import { checkPointClearance, checkRouteClearance } from './collision';
import { buildNavMesh, NavMesh, PathResult } from './navmesh';
import {
  LayoutDef,
  StaticObstacle,
  DoorDef,
  MIN_RADIUS,
  MAX_RADIUS,
  cloneLayout,
  getLayout,
} from './layouts';

export type SimStatus =
  | 'idle'
  | 'ready'
  | 'moving'
  | 'arrived'
  | 'no-path'
  | 'start-invalid'
  | 'goal-invalid'
  | 'trapped';

export const STATUS_TEXT: Record<SimStatus, string> = {
  idle: '待设置',
  ready: '路线就绪',
  moving: '行进中',
  arrived: '已到达目的地',
  'no-path': '当前无可达路线',
  'start-invalid': '起点落在障碍内或越界',
  'goal-invalid': '终点落在障碍内或越界',
  trapped: '角色所在位置被障碍占住, 已暂停, 请移开障碍',
};

/** 角色行进速度(场景单位/秒) */
const MOVE_SPEED = 5;

export class Simulation {
  readonly width: number;
  readonly height: number;

  private layout: LayoutDef;
  private staticObstacles: StaticObstacle[];
  private doors: DoorDef[];
  private doorsOpen: Record<string, boolean>;
  radius: number;

  start: Vec2;
  goal: Vec2;
  position: Vec2;

  status: SimStatus = 'idle';
  statusDetail = '';
  repathCount = 0;
  playing = false;

  navMesh: NavMesh;
  /** 当前唯一有效的路线结果; 通路变化后旧结果立即丢弃 */
  pathResult: PathResult | null = null;
  /** 当前路线折线(等于 pathResult.route 的快照, 供渲染层直接使用) */
  route: Vec2[] = [];
  /** 行进时指向下一个路线点的下标 */
  waypointIndex = 1;
  lastPathMethod: 'funnel' | 'centers' | null = null;

  constructor(layout: LayoutDef) {
    this.layout = cloneLayout(layout);
    this.width = this.layout.width;
    this.height = this.layout.height;
    this.staticObstacles = this.layout.staticObstacles.map((o) => ({ ...o }));
    this.doors = this.layout.doors.map((d) => ({ ...d }));
    this.doorsOpen = { ...this.layout.doorsOpen };
    this.radius = this.layout.defaultRadius;
    this.start = { ...this.layout.start };
    this.goal = { ...this.layout.goal };
    this.position = { ...this.layout.start };
    this.navMesh = buildNavMesh(this.activeObstacles(), this.radius, this.width, this.height);
    this.recompute('初始化');
  }

  // ---------- 障碍与门 ----------

  /** 当前实际参与碰撞的矩形: 静态障碍 + 处于关闭状态的门 */
  activeObstacles(): Rect[] {
    const closedDoors = this.doors.filter((d) => !this.doorsOpen[d.doorId]).map((d) => d as Rect);
    return [...this.staticObstacles.map((o) => o as Rect), ...closedDoors];
  }

  get obstacleList(): StaticObstacle[] {
    return this.staticObstacles;
  }

  get doorList(): DoorDef[] {
    return this.doors;
  }

  isDoorOpen(doorId: string): boolean {
    return this.doorsOpen[doorId] ?? false;
  }

  /** 运行中也允许开关门; 状态与路线立即更新 */
  setDoorOpen(doorId: string, open: boolean): void {
    if ((this.doorsOpen[doorId] ?? false) === open) return;
    this.doorsOpen[doorId] = open;
    this.rebuildAndRepath(open ? `打开${doorId}` : `关闭${doorId}`);
  }

  toggleDoor(doorId: string): void {
    this.setDoorOpen(doorId, !this.isDoorOpen(doorId));
  }

  /** 暂停后拖动障碍用。移动过程中每帧调用也安全(会重建网格) */
  moveObstacle(index: number, next: Rect): void {
    const o = this.staticObstacles[index];
    if (!o) return;
    o.x = Math.max(0, Math.min(this.width - next.w, next.x));
    o.y = Math.max(0, Math.min(this.height - next.h, next.y));
    o.w = next.w;
    o.h = next.h;
    this.rebuildAndRepath('拖动障碍');
  }

  setRadius(radius: number): void {
    const clamped = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, radius));
    if (Math.abs(clamped - this.radius) <= EPS) return;
    this.radius = clamped;
    this.rebuildAndRepath('调整角色半径');
  }

  // ---------- 起终点 ----------

  setStart(p: Vec2): void {
    this.start = { ...p };
    // 只有角色尚未出发(或在起点)时才同步位置; 行进中改起点不传送角色
    if (this.status === 'idle' || this.status === 'ready' || this.status === 'start-invalid') {
      this.position = { ...p };
      this.waypointIndex = 1;
    }
    this.recompute('设置起点');
  }

  setGoal(p: Vec2): void {
    this.goal = { ...p };
    this.recompute('设置终点');
  }

  // ---------- 播放控制 ----------

  play(): void {
    if (this.status === 'moving' || this.status === 'ready') {
      this.playing = true;
      this.status = 'moving';
    }
  }

  pause(): void {
    this.playing = false;
  }

  togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /** 恢复布局: 障碍、门、半径、起终点、角色位置、统计全部回到初始值 */
  resetLayout(): void {
    this.layout = cloneLayout(getLayout(this.layout.id));
    this.staticObstacles = this.layout.staticObstacles.map((o) => ({ ...o }));
    this.doors = this.layout.doors.map((d) => ({ ...d }));
    this.doorsOpen = { ...this.layout.doorsOpen };
    this.radius = this.layout.defaultRadius;
    this.start = { ...this.layout.start };
    this.goal = { ...this.layout.goal };
    this.position = { ...this.layout.start };
    this.repathCount = 0;
    this.playing = false;
    this.waypointIndex = 1;
    this.navMesh = buildNavMesh(this.activeObstacles(), this.radius, this.width, this.height);
    this.recompute('恢复布局');
  }

  // ---------- 核心: 重建网格 + 重新寻路 ----------

  private rebuildAndRepath(reason: string): void {
    this.navMesh = buildNavMesh(this.activeObstacles(), this.radius, this.width, this.height);
    this.recompute(reason);
  }

  /**
   * 重新评估当前局面。
   * 判定顺序:
   *   角色位置被占(且角色与起点不重合) -> trapped
   *   起点非法 -> start-invalid / 终点非法 -> goal-invalid
   *   不可达 -> no-path / 到达 -> arrived / 其余 -> ready|moving
   * 角色与起点重合时位置非法按"起点非法"处理(用户刚把起点放进障碍);
   * 角色行进到别处后被门/障碍压住才是 trapped。
   * 每次调用都计一次重新寻路(包括结果为不可达的尝试, 统计真实重试次数)。
   */
  recompute(reason: string): void {
    void reason;
    this.repathCount += 1;

    const obstacles = this.activeObstacles();
    const posCheck = checkPointClearance(this.position, this.radius, obstacles, this.width, this.height);
    const atStart =
      Math.abs(this.position.x - this.start.x) <= EPS &&
      Math.abs(this.position.y - this.start.y) <= EPS;

    // 1. 角色在行进途中被障碍/门占住位置: 困住, 不传送
    if (!posCheck.ok && !atStart) {
      this.invalidateRoute();
      this.status = 'trapped';
      this.statusDetail = `角色位置与障碍/边界冲突(${posCheck.reason}), 角色保持原地, 请移开障碍或重新开门`;
      this.playing = false;
      return;
    }

    // 2. 起终点合法性(含角色在起点处就不合法的情况)
    const startCheck = checkPointClearance(this.start, this.radius, obstacles, this.width, this.height);
    if (!startCheck.ok) {
      this.invalidateRoute();
      this.status = 'start-invalid';
      this.statusDetail = `起点不合法: ${startCheck.reason}`;
      this.playing = false;
      return;
    }
    const goalCheck = checkPointClearance(this.goal, this.radius, obstacles, this.width, this.height);
    if (!goalCheck.ok) {
      this.invalidateRoute();
      this.status = 'goal-invalid';
      this.statusDetail = `终点不合法: ${goalCheck.reason}`;
      this.playing = false;
      return;
    }

    // 3. 角色在起点但位置被占(理论上被上面 start-invalid 覆盖, 保险)
    if (!posCheck.ok) {
      this.invalidateRoute();
      this.status = 'trapped';
      this.statusDetail = `角色位置与障碍/边界冲突(${posCheck.reason}), 角色保持原地, 请移开障碍`;
      this.playing = false;
      return;
    }

    // 3. 导航网格寻路(从角色当前位置出发, 保证行进中重算不会回退)
    const result = this.navMesh.findPath(this.position, this.goal, obstacles);
    if (!result) {
      this.invalidateRoute();
      this.status = 'no-path';
      this.statusDetail = '导航网格中不存在连接当前位置与终点的可行走区域';
      // 停在当前合法位置(上方已确认 position 合法), 等待通路恢复后重新寻路
      this.playing = false;
      return;
    }

    this.pathResult = result;
    this.route = result.route.map((p) => ({ ...p }));
    this.lastPathMethod = result.method;
    this.waypointIndex = Math.min(1, Math.max(1, this.route.length - 1));

    if (dist(this.position, this.goal) <= EPS) {
      this.status = 'arrived';
      this.statusDetail = '角色已到达目的地';
      this.playing = false;
      return;
    }

    this.status = this.playing ? 'moving' : 'ready';
    this.statusDetail =
      `途经 ${result.cellIds.length} 个可行走区域, ` +
      `${result.method === 'funnel' ? '漏斗算法收紧' : '门户中点回退'}路线, ` +
      `全长 ${polylineLength(this.route).toFixed(2)} 单位`;
  }

  private invalidateRoute(): void {
    // 路线更新只保留当前有效结果: 旧路线立即清空, 角色不会沿旧线穿门
    this.pathResult = null;
    this.route = [];
    this.lastPathMethod = null;
    this.waypointIndex = 1;
  }

  // ---------- 帧推进 ----------

  step(dtSeconds: number): void {
    if (!this.playing) return;
    if (this.status !== 'moving') return;

    let remaining = dtSeconds * MOVE_SPEED;
    const obstacles = this.activeObstacles();

    while (remaining > EPS) {
      if (this.waypointIndex >= this.route.length) break;
      const target = this.route[this.waypointIndex];
      const d = dist(this.position, target);
      if (d <= EPS) {
        this.waypointIndex++;
        continue;
      }

      // 体积级安全检查: 下一段路在当前障碍局面下仍合法才迈脚
      const segCheck = checkRouteClearance(
        [this.position, target],
        this.radius,
        obstacles,
        this.width,
        this.height,
      );
      if (!segCheck.ok) {
        // 通路在行进中被改变: 立即停在当前合法位置并重新寻路, 绝不沿旧线继续
        this.rebuildAndRepath('行进中通路变化');
        return;
      }

      const stepLen = Math.min(remaining, d);
      this.position = {
        x: this.position.x + ((target.x - this.position.x) / d) * stepLen,
        y: this.position.y + ((target.y - this.position.y) / d) * stepLen,
      };
      remaining -= stepLen;
      if (stepLen >= d - EPS) {
        this.waypointIndex++;
      }
    }

    if (this.waypointIndex >= this.route.length || dist(this.position, this.goal) <= EPS) {
      this.position = { ...this.goal };
      this.playing = false;
      this.status = 'arrived';
      this.statusDetail = '角色已到达目的地';
      this.route = [];
      this.pathResult = null;
      this.lastPathMethod = null;
    }
  }

  /** 剩余路程: 当前位置到终点沿当前路线的长度; 无路线时为 0 */
  get remainingDistance(): number {
    if (!this.route || this.route.length === 0) return 0;
    let total = dist(this.position, this.route[Math.min(this.waypointIndex, this.route.length - 1)]);
    for (let i = this.waypointIndex + 1; i < this.route.length; i++) {
      total += dist(this.route[i - 1], this.route[i]);
    }
    return total;
  }

  /** 当前路线沿途的独立碰撞校验(供验证入口与 UI 实时显示) */
  verifyRoute(): ReturnType<typeof checkRouteClearance> {
    if (this.route.length < 2) {
      return checkPointClearance(this.position, this.radius, this.activeObstacles(), this.width, this.height);
    }
    return checkRouteClearance(this.route, this.radius, this.activeObstacles(), this.width, this.height);
  }
}
