/**
 * 固定步长驱动器.
 *
 * 物理以 fixedDt 为唯一时间单位推进, 与显示帧率彻底解耦:
 *  - 运行时把真实帧间隔 (带上限) 累加, 按 fixedDt 消耗;
 *  - 30/60 帧切换只改变渲染节流, 不改变物理步进;
 *  - 暂停时累加器冻结, 恢复时重置计时起点, 不会补跑一大段;
 *  - 单步精确推进一个 fixedDt.
 */
import type { ClothSimulation } from './cloth';

export type DisplayFps = 30 | 60;
export type RunState = 'running' | 'paused';

/** 单帧最多补跑的模拟时间, 防止卡顿/切后台后螺旋追赶失控 */
const MAX_FRAME_CATCH_UP = 0.05;

export class SimulationDriver {
  readonly sim: ClothSimulation;
  state: RunState = 'paused';
  displayFps: DisplayFps = 60;
  /** 物理固定步长 (秒), 即界面上可调的"模拟步长" */
  fixedDt: number;

  private accumulator = 0;
  private lastWallTime: number | null = null;
  private nextRenderTime = 0;
  private renderDue = true;
  /** 本帧实际执行的物理步数, 供界面展示 */
  lastFrameSteps = 0;

  constructor(sim: ClothSimulation, fixedDt: number) {
    this.sim = sim;
    this.fixedDt = fixedDt;
    this.sim.setDt(fixedDt);
  }

  setFixedDt(dt: number): void {
    this.fixedDt = dt;
    this.sim.setDt(dt);
    this.accumulator = 0;
  }

  setDisplayFps(fps: DisplayFps): void {
    this.displayFps = fps;
    // 渲染节奏立即按新帧率重新计时
    this.nextRenderTime = performance.now() / 1000;
    this.renderDue = true;
  }

  play(): void {
    if (this.state === 'running') return;
    this.state = 'running';
    // 关键: 恢复时丢弃暂停期间的墙钟时间, 不补跑
    this.lastWallTime = null;
    this.accumulator = 0;
  }

  pause(): void {
    this.state = 'paused';
    this.lastWallTime = null;
  }

  toggle(): void {
    if (this.state === 'running') this.pause();
    else this.play();
  }

  /** 单步: 无论运行状态, 精确推进一次 fixedDt */
  stepOnce(): void {
    this.pause();
    this.sim.step();
    this.renderDue = true;
  }

  /** 用同一预设重新构造的 sim 替换当前实例, 状态回到初始条件 */
  replaceSim(sim: ClothSimulation): void {
    (this as { sim: ClothSimulation }).sim = sim;
    sim.setDt(this.fixedDt);
    this.state = 'paused';
    this.accumulator = 0;
    this.lastWallTime = null;
    this.renderDue = true;
  }

  /**
   * 每个动画帧调用一次.
   * @param wallSeconds 当前墙钟时间 (秒)
   * @param maxSteps 本帧最多执行的物理步数 (默认不限, 仍受内部 64 步保护)
   * @returns 是否应当渲染本帧 (受 displayFps 节流)
   */
  frame(wallSeconds: number, maxSteps = Infinity): boolean {
    this.lastFrameSteps = 0;
    if (this.state === 'running') {
      if (this.lastWallTime === null) {
        this.lastWallTime = wallSeconds;
        this.nextRenderTime = wallSeconds;
      }
      let elapsed = wallSeconds - this.lastWallTime;
      this.lastWallTime = wallSeconds;
      // 钳制真实帧间隔: 切后台/卡顿不会引发追赶风暴
      if (elapsed > MAX_FRAME_CATCH_UP) elapsed = MAX_FRAME_CATCH_UP;
      if (elapsed < 0) elapsed = 0;
      this.accumulator += elapsed;

      const cap = Math.min(64, Math.max(0, Math.floor(maxSteps)));
      let guard = 0;
      while (this.accumulator >= this.fixedDt - 1e-12 && guard < cap) {
        this.sim.step();
        this.accumulator -= this.fixedDt;
        this.lastFrameSteps++;
        guard++;
      }
      if (guard >= 64) this.accumulator = 0;
    }

    const renderInterval = 1 / this.displayFps;
    if (this.renderDue || wallSeconds >= this.nextRenderTime) {
      this.renderDue = false;
      this.nextRenderTime = wallSeconds + renderInterval;
      return true;
    }
    return false;
  }
}
