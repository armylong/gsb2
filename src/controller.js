// controller.js
// 播放控制器：把真实帧间隔（任意帧率）翻译成固定仿真步，
// 并在比较模式下让 A/B 两个 ParticleSystem 严格锁步。
//
// 不变量：任意时刻 systemA.tick === systemB.tick，
// 因此切换 A/B/并排比较时，两边画面一定处于同一播放时间。
//
// 无漂移做法：累计真实流逝时间 elapsed，每帧按 round(elapsed/SIM_DT)
// 得到目标 tick 再补齐步数。四舍五入吸收浮点误差（60×1/60 ≠ 1），
// 因此 30/60/144 fps 播完同一物理时长后落在同一个 tick 上。

import { ParticleSystem, SIM_DT } from './engine.js';

export class PlaybackController {
  constructor(paramsA = {}, paramsB = {}, seed = 20261118) {
    this.seed = seed >>> 0;
    this.systemA = new ParticleSystem(paramsA, this.seed);
    this.systemB = new ParticleSystem(paramsB, this.seed);
    this.playing = false;
    this.elapsed = 0; // 已纳入仿真的真实时间（秒），对齐到整步边界
  }

  get time() {
    return this.systemA.time;
  }

  get tick() {
    return this.systemA.tick;
  }

  play() {
    this.playing = true;
  }

  pause() {
    this.playing = false;
    // 暂停时把不足一步的零头对齐到当前 tick，恢复后从干净边界继续。
    this.elapsed = this.tick * SIM_DT;
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  restart() {
    this.systemA.reset();
    this.systemB.reset();
    this.elapsed = 0;
  }

  /**
   * 由渲染循环每帧调用。dtSeconds 是真实帧间隔（任意帧率均可）。
   * 帧间隔被钳制，避免后台标签页切回时一次性灌入巨量步长。
   * 返回本帧实际执行的仿真步数。
   *
   * 注意不能把 elapsed 回写为 tick*SIM_DT：那会抹掉四舍五入容差，
   * 使行为退化为逐帧 floor，浮点误差按帧数累积（144fps 会漂移）。
   */
  update(dtSeconds) {
    if (!this.playing) return 0;
    const dt = Math.min(Math.max(0, dtSeconds), 0.1);
    this.elapsed += dt;
    const targetTick = Math.round(this.elapsed / SIM_DT);
    let steps = 0;
    while (this.systemA.tick < targetTick) {
      this.systemA.step();
      this.systemB.step();
      steps++;
    }
    return steps;
  }

  /** 单步前进固定 1/60 秒（= 2 个仿真步），播放/暂停状态下均可用。 */
  stepOnce() {
    const TICKS = Math.round(1 / 60 / SIM_DT);
    this.systemA.advance(TICKS);
    this.systemB.advance(TICKS);
    this.elapsed = this.tick * SIM_DT;
    return TICKS;
  }

  /** 跳到指定时间，A/B 同时重建，保持锁步。 */
  seek(timeSeconds) {
    this.systemA.seek(timeSeconds);
    this.systemB.seek(timeSeconds);
    this.elapsed = this.tick * SIM_DT;
  }

  /**
   * 修改某一组参数：对应系统清空旧粒子并重建；
   * 另一组同步 seek 到相同时间，保证两边仍处于同一播放时间。
   */
  setParams(side, params) {
    const target = this.time;
    if (side === 'A') {
      this.systemA.setParams(params);
      this.systemA.seek(target);
    } else {
      this.systemB.setParams(params);
      this.systemB.seek(target);
    }
    this.elapsed = this.tick * SIM_DT;
  }

  /** 回到开始（时间归零，保留参数与播放/暂停状态）。 */
  goToStart() {
    this.restart();
  }
}
