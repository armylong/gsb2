import * as THREE from 'three';
import type { Disc } from './disc';

export type AutoTest = 'route' | 'landing' | 'wiggle' | null;

/**
 * 脚本路线的固定前进方向（在面板局部坐标里）：
 * floor / wall 沿 +v 走向外角，ceiling 沿 -v 走向缺面。
 * 不能取“最近边外侧”——起点离身后的场边更近，会反向冲出场地。
 */
function routeForward(disc: Disc): THREE.Vector3 {
  if (disc.mode !== 'attached') return new THREE.Vector3(0, 0, 1);
  const sign = disc.panel.id === 'ceiling' ? -1 : 1;
  return disc.panel.vAxis.clone().multiplyScalar(sign);
}

/**
 * 内置自动驾驶：直接注入世界空间意图，绕开镜头映射，
 * 用于可重复地验证外角换面、缺面坠落和迟滞防抖。
 */
export class Autopilot {
  active: AutoTest = null;
  private elapsed = 0;
  private phase = 0;
  private switchesAtStart = 0;
  private eventsAtStart = 0;
  onVerdict: ((text: string, ok: boolean) => void) | null = null;

  get isRunning() {
    return this.active !== null;
  }

  start(test: Exclude<AutoTest, null>, disc: Disc) {
    // 先 reset（会清空事件），再记录基线，否则切片下标会越界失效
    disc.reset();
    this.active = test;
    this.elapsed = 0;
    this.phase = 0;
    this.switchesAtStart = disc.events.filter((e) => e.kind === 'switch').length;
    this.eventsAtStart = disc.events.length;
  }

  stop() {
    this.active = null;
  }

  private newEvents(disc: Disc) {
    return disc.events.slice(this.eventsAtStart);
  }

  private newSwitches(disc: Disc) {
    return disc.events.filter((e) => e.kind === 'switch').length - this.switchesAtStart;
  }

  /** 返回本帧注入给圆盘的世界意图；null 表示不注入 */
  update(dt: number, disc: Disc): THREE.Vector3 | null {
    if (!this.active) return null;
    this.elapsed += dt;
    const t = this.elapsed;

    if (this.active === 'route') return this.updateRoute(t, disc);
    if (this.active === 'landing') return this.updateLanding(t, disc);
    return this.updateWiggle(t, disc);
  }

  // 路线：地面直推 → 外角1上墙 → 外角2上顶 → 缺面边跨出 → 坠落重置
  private updateRoute(t: number, disc: Disc): THREE.Vector3 | null {
    const ev = this.newEvents(disc);

    switch (this.phase) {
      case 0: // 地面直推，直到第一次换面
        if (ev.some((e) => e.kind === 'switch')) this.phase = 1;
        return routeForward(disc);
      case 1: // 立墙向上，直到第二次换面
        if (this.newSwitches(disc) >= 2) this.phase = 2;
        return routeForward(disc);
      case 2: // 顶面继续向前直到跨出缺面
        if (ev.some((e) => e.kind === 'detach')) this.phase = 3;
        return routeForward(disc);
      case 3: // 等待坠回起点
        if (ev.some((e) => e.kind === 'void-reset')) {
          this.finishRoute(disc, true, '通过：两个外角顺利换面，缺面处脱离并落回起点');
          return null;
        }
        if (t > 9) {
          this.finishRoute(disc, false, '失败：未在预期时间内完成缺面坠落重置');
          return null;
        }
        return null;
    }
    // 兜底
    return routeForward(disc);
  }

  private finishRoute(disc: Disc, ok: boolean, text: string) {
    if (ok && disc.lastSwitch) {
      const retentionOk = (disc.lastSwitch.retention ?? 1) >= 0.99;
      const switchCount = this.newSwitches(disc);
      if (switchCount < 2) ok = false;
      if (!retentionOk) ok = false;
      text = ok
        ? `通过：检测到 ${switchCount} 次外角换面，末次速率保持率 ${(disc.lastSwitch.retention * 100).toFixed(1)}%，缺面脱落后落回起点`
        : `失败：换面次数=${switchCount}，速率保持率=${(disc.lastSwitch.retention * 100).toFixed(1)}%`;
    }
    this.active = null;
    this.onVerdict?.(text, ok);
  }

  // 脱离测试：地面起步后主动脱离，应在地面上重新吸附而不是飞出场
  private updateLanding(t: number, disc: Disc): THREE.Vector3 | null {
    const ev = this.newEvents(disc);
    if (this.phase === 0) {
      if (t > 0.4) {
        disc.detach();
        this.phase = 1;
      }
      return new THREE.Vector3(0.6, 0, 0.4);
    }    if (ev.some((e) => e.kind === 'land')) {
      this.active = null;
      this.onVerdict?.('通过：主动脱离后重新吸附到地面，运动继续', true);
      return null;
    }
    if (ev.some((e) => e.kind === 'void-reset') || t > 6) {
      this.active = null;
      this.onVerdict?.('失败：脱离后未能重新吸附', false);
      return null;
    }
    return null;
  }

  // 抖动测试：推到外角1边带后左右小幅来回，检查不会连续反复换面
  private updateWiggle(t: number, disc: Disc): THREE.Vector3 | null {
    const ev = this.newEvents(disc);
    if (t < 1.4) return routeForward(disc);

    if (t < 5.6) {
      const lateral = Math.sin(t * 14) * 0.9; // 高频左右小幅输入
      return new THREE.Vector3(lateral, 0, 0.85);
    }

    const switches = this.newSwitches(disc);
    const blocked = ev.some((e) => e.kind === 'block');
    this.active = null;
    const ok = switches <= 1;
    this.onVerdict?.(
      ok
        ? `通过：边带内左右抖动期间仅 ${switches} 次换面（迟滞+冷却生效，无来回横跳）${blocked ? '' : ''}`
        : `失败：抖动期间发生 ${switches} 次换面，存在来回横跳`,
      ok,
    );
    return null;
  }
}
