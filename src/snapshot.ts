/**
 * 整帧快照与纯 JS 像素分析工具（配合 OutlinePipeline 的 capture* 方法）。
 * readRenderTargetPixels 返回 GL 行序（自下而上），这里统一转成屏幕坐标访问。
 */
export interface FrameSnapshot {
  width: number;
  height: number;
  /** ID 缓冲 RGBA（仅 r=id，gba=打包的对象自身深度） */
  id: Uint8Array;
  /** 场景深度（packDepth 布局 RGBA） */
  depth: Uint8Array;
  /** 最终合成画面 sRGB RGBA */
  composite: Uint8Array;
}

function idx(snap: FrameSnapshot, x: number, y: number): number {
  const cx = Math.max(0, Math.min(snap.width - 1, Math.floor(x)));
  // 屏幕 y 自上而下，GL 缓冲自下而上
  const gy = Math.max(0, Math.min(snap.height - 1, snap.height - 1 - Math.floor(y)));
  return (gy * snap.width + cx) * 4;
}

export function sampleId(snap: FrameSnapshot, x: number, y: number): number {
  return snap.id[idx(snap, x, y)];
}

/** 与 GLSL packDepth 的 rgba 位布局一致的解码。 */
export function unpackDepth(r: number, g: number, b: number, a: number): number {
  return r / 255 + g / 65025 + b / 16581375 + a / 4294967295;
}

/** ID 缓冲深度只打在 GBA 三通道（R 通道被 ID 占用）。 */
export function sampleIdDepth(snap: FrameSnapshot, x: number, y: number): number {
  const i = idx(snap, x, y);
  return snap.id[i + 1] / 255 + snap.id[i + 2] / 65025 + snap.id[i + 3] / 16581375;
}

export function sampleSceneDepth(snap: FrameSnapshot, x: number, y: number): number {
  const i = idx(snap, x, y);
  return unpackDepth(snap.depth[i], snap.depth[i + 1], snap.depth[i + 2], snap.depth[i + 3]);
}

export function sampleComposite(
  snap: FrameSnapshot,
  x: number,
  y: number,
): [number, number, number, number] {
  const i = idx(snap, x, y);
  return [snap.composite[i], snap.composite[i + 1], snap.composite[i + 2], snap.composite[i + 3]];
}

export function srgbColor(linear: { r: number; g: number; b: number }): [number, number, number] {
  const enc = (c: number) =>
    c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 255 / 600) - 0.055;
  return [enc(linear.r) * 255, enc(linear.g) * 255, enc(linear.b) * 255];
}

export function colorDistance(a: [number, number, number, number], b: [number, number, number]) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/** 在以 (cx,cy) 为中心、半径 r 的圆环上找最接近目标色的合成像素。 */
export function nearestColorInRing(
  snap: FrameSnapshot,
  cx: number,
  cy: number,
  maxRadius: number,
  target: [number, number, number],
): { distance: number; x: number; y: number } {
  let best = Infinity;
  let bx = cx;
  let by = cy;
  for (let r = 2; r <= maxRadius; r += 2) {
    for (let a = 0; a < 24; a++) {
      const ang = (a / 24) * Math.PI * 2;
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r;
      if (x < 0 || y < 0 || x >= snap.width || y >= snap.height) continue;
      const px = sampleComposite(snap, x, y);
      const d = colorDistance(px, target);
      if (d < best) {
        best = d;
        bx = x;
        by = y;
      }
    }
  }
  return { distance: best, x: bx, y: by };
}
