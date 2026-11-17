// engine.js
// 纯逻辑粒子仿真引擎：无 DOM、无渲染依赖，可在 Node 中直接测试。
//
// 确定性保证：
//  1. 固定时间步 SIM_DT，所有运动积分与发射判定都基于整步 tick，与帧率无关；
//  2. 发射使用种子化 PRNG（mulberry32），同一参数 + 同一时间点的随机序列完全一致；
//  3. seek(t) 通过从 t=0 重新积分到目标 tick 重建状态，可精确复现任意画面；
//  4. 粒子达到数量上限后回收"最老批次"槽位（环形游标），数组永不越界。

export const SIM_DT = 1 / 120; // 固定仿真步长（秒），与渲染帧率解耦
export const MAX_PARTICLES = 400; // 固定粒子数量上限
export const GRAVITY = 0.12; // 归一化坐标系下的重力加速度（单位/秒²）
export const EMITTER_X = 0.5; // 发射器位置（归一化坐标，y 轴向上）
export const EMITTER_Y = 0.12;
export const SPREAD_ANGLE = (25 * Math.PI) / 180; // 发射锥半角，围绕正上方

/** 种子化伪随机数生成器（mulberry32），返回一个产出 [0,1) 的函数。 */
export function createRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 用默认值补全并约束一组粒子参数。 */
export function normalizeParams(p = {}) {
  const clamp = (v, min, max, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  };
  return {
    emissionRate: clamp(p.emissionRate, 1, 240, 60), // 每秒发射个数
    lifetime: clamp(p.lifetime, 0.2, 6, 2.2), // 粒子寿命（秒）
    speed: clamp(p.speed, 0.05, 1.2, 0.45), // 初速度（归一化单位/秒）
    hue: clamp(p.hue, 0, 360, 200), // 基础色相
    hueRange: clamp(p.hueRange, 0, 180, 60), // 色相随机范围
    hueShift: clamp(p.hueShift, -180, 180, 40), // 寿命期内色相漂移量
    gravityScale: clamp(p.gravityScale, 0, 3, 1), // 重力倍率
  };
}

export const DEFAULT_PARAMS = Object.freeze(normalizeParams({}));

/**
 * 单发射器粒子系统。
 * 状态只由 (params, tick, particles, rng 状态, 发射累加器) 构成，
 * 全部可通过 reset + 逐步积分确定性地重建。
 */
export class ParticleSystem {
  constructor(params = {}, seed = 1) {
    this.seed = seed >>> 0;
    this.params = normalizeParams(params);
    this.reset();
  }

  /** 清空所有粒子并把时间轴拨回 0（seek / 改参数 / 回到开始时调用）。 */
  reset() {
    this.particles = [];
    this.tick = 0;
    this.emissionAccumulator = 0;
    this.recycleHead = 0;
    this.totalEmitted = 0; // 累计发射数（统计用，含被回收的粒子）
    this.totalExpired = 0; // 累计自然消亡数
    this.rng = createRng(this.seed);
  }

  get time() {
    return this.tick * SIM_DT;
  }

  get aliveCount() {
    return this.particles.length;
  }

  /** 更换参数并清空旧粒子（参数只影响之后的播放，不回改历史画面）。 */
  setParams(params) {
    this.params = normalizeParams(params);
    this.reset();
  }

  /** 发射一个粒子，随机数全部在发射时刻从同一 rng 顺序取出。 */
  emit() {
    const rng = this.rng;
    const p = this.params;
    const angle = Math.PI / 2 + (rng() * 2 - 1) * SPREAD_ANGLE;
    const speedJitter = 0.82 + rng() * 0.36;
    const speed = p.speed * speedJitter;
    const lifeJitter = 0.85 + rng() * 0.3;
    const baseHue = (p.hue + (rng() * 2 - 1) * p.hueRange + 360) % 360;
    const particle = {
      x: EMITTER_X,
      y: EMITTER_Y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      age: 0,
      life: p.lifetime * lifeJitter,
      size: 0.018 + rng() * 0.016,
      hue0: baseHue,
      bornTick: this.tick,
    };

    if (this.particles.length < MAX_PARTICLES) {
      this.particles.push(particle);
    } else {
      // 数量上限：环形游标回收最老批次槽位，系统持续运行、统计仍然准确。
      this.particles[this.recycleHead] = particle;
      this.recycleHead = (this.recycleHead + 1) % MAX_PARTICLES;
    }
    this.totalEmitted++;
  }

  /** 推进一个固定时间步。顺序固定：先发射，再积分，最后回收，保证可复现。 */
  step() {
    // 发射判定按"本步应发射的小数个粒子"累加，跨步余数保留，
    // 因此低帧率与高帧率下总发射数只取决于经过的时间。
    this.emissionAccumulator += this.params.emissionRate * SIM_DT;
    while (this.emissionAccumulator >= 1) {
      this.emit();
      this.emissionAccumulator -= 1;
    }

    const g = GRAVITY * this.params.gravityScale;
    const dt = SIM_DT;
    const next = [];
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.vy -= g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.age += dt;
      if (p.age < p.life) {
        next.push(p);
      } else {
        this.totalExpired++;
      }
    }
    this.particles = next;
    // 压缩后若回收游标越界则夹紧（仅在数组短于上限时可能发生）。
    if (this.recycleHead >= next.length) this.recycleHead = 0;
    this.tick++;
  }

  /** 推进 n 个整步。 */
  advance(ticks) {
    for (let i = 0; i < ticks; i++) this.step();
  }

  /**
   * 跳到指定时间：清空状态后从 t=0 重新积分到对应 tick。
   * 同一参数 + 同一时间点永远得到同一画面（与此前播放路径无关）。
   */
  seek(timeSeconds) {
    const target = Math.max(0, Math.round(timeSeconds / SIM_DT));
    this.reset();
    this.advance(target);
  }

  /** 当前粒子在某寿命比例下的色相（供渲染器使用，纯函数）。 */
  particleHue(particle) {
    const t = Math.min(1, particle.age / particle.life);
    return (particle.hue0 + this.params.hueShift * t + 360) % 360;
  }
}
