/*
 * player.js — Web Audio 播放管理
 * 设计要点：
 *  - 原始播放与循环试听共用一个 AudioContext；切换/停止时先停掉并丢弃旧 AudioBufferSourceNode，
 *    旧节点不会再发声（不残留上一版区间）。
 *  - 多轮循环用 AudioBufferSourceNode.loop=true 实现，循环点在音频硬件层逐帧衔接，无播放空隙。
 *  - 区间或淡化参数改变后重建 loopBuffer，下一次播放立即使用新版本。
 */
(function (global) {
  'use strict';

  class Player {
    constructor() {
      this.ctx = null;
      this.source = null;
      this.mode = null; // 'original' | 'loop'
      this.playing = false;
      this.startCtxTime = 0;
      this.startOffset = 0;
      this.bufferDuration = 0;
      this.onEnded = null;
      this.stopTimer = null;
    }

    ensureCtx() {
      if (!this.ctx) {
        const AC = global.AudioContext || global.webkitAudioContext;
        if (!AC) throw new Error('当前浏览器不支持 Web Audio API');
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }

    /* 平面 Float32 声道 -> AudioBuffer（采样率与源文件一致，不重采样） */
    makeBuffer(channels, sampleRate) {
      const ctx = this.ensureCtx();
      const buf = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
      for (let c = 0; c < channels.length; c++) buf.copyToChannel(channels[c], c);
      return buf;
    }

    _teardownSource() {
      if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
      if (this.source) {
        try {
          this.source.onended = null;
          this.source.stop();
        } catch (e) { /* 已停止的节点 stop 会抛异常，忽略 */ }
        try { this.source.disconnect(); } catch (e) { /* ignore */ }
        this.source = null;
      }
      this.playing = false;
    }

    stop() {
      this._teardownSource();
      this.mode = null;
    }

    /*
     * 播放。buffer: AudioBuffer；mode: 'original' | 'loop'；
     * rounds: 循环轮数，0 表示持续到手动停止；offsetSec: 原始模式起始偏移。
     */
    play(buffer, mode, rounds, offsetSec) {
      const ctx = this.ensureCtx();
      this._teardownSource();

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);

      this.source = src;
      this.mode = mode;
      this.playing = true;
      this.startCtxTime = ctx.currentTime;
      this.startOffset = offsetSec || 0;
      this.bufferDuration = buffer.duration;

      if (mode === 'loop') {
        src.loop = true;
        src.loopStart = 0;
        src.loopEnd = buffer.duration;
      }

      src.onended = () => {
        // 主动 teardown 会先把 onended 置空，因此走到这里只可能是自然结束
        if (this.source === src) {
          this.playing = false;
          this.source = null;
          if (this.onEnded) this.onEnded(mode);
        }
      };

      src.start(0, this.startOffset);

      if (mode === 'loop' && rounds > 0) {
        const totalDur = buffer.duration * rounds - this.startOffset;
        this.stopTimer = global.setTimeout(() => {
          this.stopTimer = null;
          if (this.source === src) this.stop();
        }, Math.max(0, Math.round(totalDur * 1000)));
      }
    }

    /* 当前播放头（秒，缓冲区局部时间；循环模式自动折算到一轮之内） */
    currentTime() {
      if (!this.ctx || !this.playing || !this.source) return this.startOffset;
      const t = this.startOffset + (this.ctx.currentTime - this.startCtxTime);
      if (this.mode === 'loop' && this.bufferDuration > 0) return t % this.bufferDuration;
      return Math.min(t, this.bufferDuration);
    }
  }

  global.LoopPlayer = Player;
})(typeof globalThis !== 'undefined' ? globalThis : this);
