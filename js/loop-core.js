/*
 * loop-core.js — 循环区间/接缝算法（无 DOM 依赖，浏览器与 Node 测试共用）
 *
 * 接缝处理采用「环形交叉淡化」：把循环区间想象成首尾相接的圆环，
 * 以接缝为中心、左右各 F 帧做线性等功率互补增益的交叉淡化，
 * 其余中间部分保持原采样不变。输出循环长度 = L - F 帧，
 * 且输出最后一帧与第一帧在源信号中本就是相邻采样，天然消除接缝跳变。
 * 左右声道始终使用同一组循环边界。
 */
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LoopCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  class LoopError extends Error {
    constructor(message) {
      super(message);
      this.name = 'LoopError';
    }
  }

  function isInt(x) { return Number.isInteger(x); }

  /* 校验并归一化区间参数。totalFrames 为文件总帧数。 */
  function validateLoop(totalFrames, startFrame, endFrame, fadeFrames) {
    if (!isInt(totalFrames) || totalFrames <= 0) throw new LoopError('文件没有可用的音频帧');
    if (!isInt(startFrame) || !isInt(endFrame)) throw new LoopError('起止位置必须是整数采样帧');
    if (startFrame < 0 || endFrame > totalFrames) throw new LoopError('区间超出文件范围');
    if (endFrame - startFrame < 2) throw new LoopError('循环区间至少包含 2 个采样帧');
    const L = endFrame - startFrame;
    let F = fadeFrames | 0;
    if (F < 0) throw new LoopError('淡化帧数不能为负');
    const maxF = Math.floor(L / 2);
    let clamped = false;
    if (F > maxF) { F = maxF; clamped = true; }
    return { startFrame, endFrame, lengthFrames: L, fadeFrames: F, maxFadeFrames: maxF, fadeClamped: clamped };
  }

  /* 源区间未淡化前的接缝跳变（每声道 |x[end-1]-x[start]|），用于 UI 提示 */
  function rawSeamJump(channels, startFrame, endFrame) {
    return channels.map((ch) => Math.abs(ch[endFrame - 1] - ch[startFrame]));
  }

  /* 已生成循环的接缝跳变：输出最后一帧与第一帧之差 */
  function loopSeamJump(loopChannels) {
    const n = loopChannels[0].length;
    return loopChannels.map((ch) => Math.abs(ch[n - 1] - ch[0]));
  }

  function maxAbs(ch) {
    let m = 0;
    for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > m) m = a; }
    return m;
  }

  /*
   * 生成淡化后的循环（平面 Float32 声道数组）。
   * 输入 channels: Float32Array[]；输出长度 = L - F。
   */
  function buildLoop(channels, startFrame, endFrame, fadeFrames) {
    const cfg = validateLoop(channels[0].length, startFrame, endFrame, fadeFrames);
    const L = cfg.lengthFrames, F = cfg.fadeFrames;
    const N = L - F;
    const out = channels.map(() => new Float32Array(N));
    const tail = startFrame + L - F; // 源中淡化尾段起点（输出位置 0 对应源 tail）

    for (let n = 0; n < N; n++) {
      if (n < F) {
        const gHead = (n + 1) / (F + 1); // 头段（接缝之后）淡入
        const gTail = 1 - gHead;         // 尾段（接缝之前）淡出，互补增益
        const iTail = tail + n;
        const iHead = startFrame + n;
        for (let c = 0; c < channels.length; c++) {
          out[c][n] = channels[c][iTail] * gTail + channels[c][iHead] * gHead;
        }
      } else {
        for (let c = 0; c < channels.length; c++) out[c][n] = channels[c][startFrame + n];
      }
    }
    return { channels: out, lengthFrames: N, config: cfg };
  }

  function msToFrames(ms, sampleRate) {
    if (!(ms >= 0)) return 0;
    return Math.max(0, Math.round((ms / 1000) * sampleRate));
  }
  function framesToMs(frames, sampleRate) { return (frames / sampleRate) * 1000; }

  return {
    LoopError, validateLoop, buildLoop, rawSeamJump, loopSeamJump, maxAbs,
    msToFrames, framesToMs,
  };
});
