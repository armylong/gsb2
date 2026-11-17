/*
 * geometry.js — 波形视图与采样帧之间的换算（无 DOM 依赖，可单元测试）
 */
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Geometry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  /* 视图：viewStart 为首帧，framesPerPixel 为缩放比例（>= 1/某基数，这里允许小数） */
  function frameAtX(x, viewStart, framesPerPixel, canvasWidth, totalFrames) {
    const f = Math.round(viewStart + x * framesPerPixel);
    return clamp(f, 0, totalFrames);
  }
  function xAtFrame(frame, viewStart, framesPerPixel) {
    return (frame - viewStart) / framesPerPixel;
  }

  /* 缩放：以 anchorFrame（鼠标位置对应的帧）为锚点 */
  function zoomView(viewStart, framesPerPixel, factor, anchorFrame, canvasWidth, totalFrames) {
    const next = clamp(framesPerPixel * factor, 0.25, totalFrames / Math.max(1, canvasWidth) * 4 || 1);
    let start = anchorFrame - (anchorFrame - viewStart) * (next / framesPerPixel);
    const maxStart = Math.max(0, totalFrames - next * canvasWidth);
    start = clamp(start, 0, maxStart);
    return { viewStart: Math.round(start), framesPerPixel: next };
  }

  /* 波形峰值预计算：按像素桶取 min/max，返回每桶 {min,max} 数组（每个声道独立） */
  function buildPeaks(samples, bucketFrames) {
    const n = samples.length;
    const buckets = Math.max(1, Math.ceil(n / Math.max(1, bucketFrames)));
    const min = new Float32Array(buckets);
    const max = new Float32Array(buckets);
    for (let b = 0; b < buckets; b++) {
      const lo = b * bucketFrames, hi = Math.min(n, lo + bucketFrames);
      let mn = Infinity, mx = -Infinity;
      for (let i = lo; i < hi; i++) {
        const v = samples[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      min[b] = mn === Infinity ? 0 : mn;
      max[b] = mx === -Infinity ? 0 : mx;
    }
    return { min, max, buckets, bucketFrames };
  }

  return { clamp, frameAtX, xAtFrame, zoomView, buildPeaks };
});
