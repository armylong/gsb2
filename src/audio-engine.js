// 音频引擎：用 HRTF PannerNode 把每个声源放到三维场景对应位置。
// 设计要点：
// 1. 每次状态提交都做一次「期望状态 vs 实际音频图」的对账——该建的建、该停的立刻停，
//    因此快速拖动 / 转向 / 播放切换不会残留旧位置的声音或残留播放。
// 2. 位置/朝向用极小时间常数的 setTargetAtTime 平滑，避免爆音；建声时先 setValueAtTime
//    定位到当前坐标，避免从原点滑入的错误听感。
// 3. 独奏通过增益静音实现，不改写各声源自己的 playing/volume。
// 4. 同时支持 AudioContext 与 OfflineAudioContext（后者供自动化测试离线渲染验证）。

import { createSynth } from './synth.js';

const SMOOTH_TAU = 0.03; // 约 30ms，既平滑又不会让声音停留在旧位置

export function yawToForward(yawDeg) {
  const yaw = (yawDeg * Math.PI) / 180;
  return { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
}

export class AudioEngine {
  constructor(store, options = {}) {
    this.store = store;
    this.contextFactory = options.contextFactory || (() => new AudioContext());
    this.onStatus = options.onStatus || (() => {});
    this.ctx = null;
    this.voices = new Map(); // id -> { synth, userGain, panner }
    this.master = null;
    this.unsubscribe = store.subscribe((state) => this.sync(state));
    this._report('disabled', '尚未启用音频：请点击「启用声音」按钮（浏览器要求先由用户操作开启音频）。');
  }

  _report(kind, message) {
    this.status = { kind, message };
    this.onStatus(this.status);
  }

  get available() {
    return typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined';
  }

  // 仅在明确的用户手势里调用
  async enable() {
    if (!this.available) {
      this._report('unavailable', '当前浏览器不支持 Web Audio API，请使用最新版 Chrome / Edge / Firefox / Safari 后重试。');
      return false;
    }
    try {
      if (!this.ctx) {
        this.ctx = this.contextFactory();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.9;
        const compressor = this.ctx.createDynamicsCompressor();
        compressor.threshold.value = -18;
        compressor.ratio.value = 6;
        this.master.connect(compressor).connect(this.ctx.destination);
        if (this.ctx.addEventListener) {
          this.ctx.addEventListener('statechange', () => this._emitContextState());
        }
      }
      if (this.ctx.state === 'suspended' && typeof this.ctx.resume === 'function') {
        await this.ctx.resume();
      }
      if (this.ctx.state === 'suspended') {
        this._report('suspended', '音频已初始化但被浏览器挂起：请再次点击「启用声音」或页面任意位置恢复。');
      } else if (this.ctx.state === 'running') {
        this._report('running', '音频运行中：拖动声源与听者即可听到方位和距离变化。');
      } else {
        this._report('ready', '音频已启用（离线/测试上下文）。');
      }
      this.store.setAudioEnabled(true);
      this.sync(this.store.state);
      return true;
    } catch (err) {
      this._report('error', `音频启用失败：${err?.message || err}。请检查系统输出设备与浏览器麦克风/声音权限后重试。`);
      return false;
    }
  }

  _emitContextState() {
    if (!this.ctx) return;
    if (this.ctx.state === 'running') {
      this._report('running', '音频运行中：拖动声源与听者即可听到方位和距离变化。');
    } else if (this.ctx.state === 'suspended') {
      this._report('suspended', '音频被浏览器挂起：点击页面任意位置即可恢复试听。');
    } else if (this.ctx.state === 'closed') {
      this._report('unavailable', '音频上下文已关闭：请刷新页面后重新启用声音。');
    }
  }

  _createVoice(src) {
    const ctx = this.ctx;
    const synth = createSynth(ctx, src.type);
    const userGain = ctx.createGain();
    userGain.gain.value = src.volume;
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.rolloffFactor = 1.2;
    panner.maxDistance = 40;
    // 立刻定位到当前坐标，避免从原点滑入
    const t = ctx.currentTime;
    panner.positionX.setValueAtTime(src.x, t);
    panner.positionY.setValueAtTime(src.y, t);
    panner.positionZ.setValueAtTime(src.z, t);
    synth.output.connect(userGain).connect(panner).connect(this.master);
    this.voices.set(src.id, { synth, userGain, panner });
  }

  _destroyVoice(id) {
    const voice = this.voices.get(id);
    if (!voice) return;
    try { voice.synth.stop(); } catch { /* 已停止 */ }
    try { voice.userGain.disconnect(); } catch { /* noop */ }
    try { voice.panner.disconnect(); } catch { /* noop */ }
    this.voices.delete(id);
  }

  _applyListener(listener) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const pos = [listener.x, listener.y, listener.z];
    if (ctx.listener.positionX) {
      ctx.listener.positionX.setTargetAtTime(pos[0], t, SMOOTH_TAU);
      ctx.listener.positionY.setTargetAtTime(pos[1], t, SMOOTH_TAU);
      ctx.listener.positionZ.setTargetAtTime(pos[2], t, SMOOTH_TAU);
    } else if (ctx.listener.setPosition) {
      ctx.listener.setPosition(...pos);
    }
    const f = yawToForward(listener.yaw);
    if (ctx.listener.forwardX) {
      ctx.listener.forwardX.setTargetAtTime(f.x, t, SMOOTH_TAU);
      ctx.listener.forwardY.setTargetAtTime(f.y, t, SMOOTH_TAU);
      ctx.listener.forwardZ.setTargetAtTime(f.z, t, SMOOTH_TAU);
      ctx.listener.upX.setValueAtTime(0, t);
      ctx.listener.upY.setValueAtTime(1, t);
      ctx.listener.upZ.setValueAtTime(0, t);
    } else if (ctx.listener.setOrientation) {
      ctx.listener.setOrientation(f.x, f.y, f.z, 0, 1, 0);
    }
  }

  // 状态对账：store 每次提交都会调用
  sync(state) {
    if (!this.ctx) return;
    this._applyListener(state.listener);
    const t = this.ctx.currentTime;

    for (const src of state.sources) {
      const shouldExist = src.playing;
      let voice = this.voices.get(src.id);
      if (shouldExist && !voice) {
        this._createVoice(src);
        voice = this.voices.get(src.id);
      } else if (!shouldExist && voice) {
        this._destroyVoice(src.id);
        continue;
      }
      if (!voice) continue;

      // 位置持续跟踪：快速拖动时每个提交事件都重置目标，声音不会停在旧位置
      voice.panner.positionX.setTargetAtTime(src.x, t, SMOOTH_TAU);
      voice.panner.positionY.setTargetAtTime(src.y, t, SMOOTH_TAU);
      voice.panner.positionZ.setTargetAtTime(src.z, t, SMOOTH_TAU);

      // 独奏只影响最终增益，不动 playing 状态
      const audible = state.soloId === null || state.soloId === src.id;
      const targetGain = audible ? src.volume : 0;
      voice.userGain.gain.setTargetAtTime(targetGain, t, SMOOTH_TAU);
    }
  }

  // 重置/暂停全部：立即销毁所有发声体，杜绝残留播放
  stopAll() {
    for (const id of [...this.voices.keys()]) this._destroyVoice(id);
  }

  async dispose() {
    this.unsubscribe();
    this.stopAll();
    if (this.ctx && typeof this.ctx.close === 'function' && this.ctx.state !== 'closed') {
      try { await this.ctx.close(); } catch { /* noop */ }
    }
    this.ctx = null;
  }
}
