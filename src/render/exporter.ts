/**
 * 按指定分辨率导出最终画面为透明 PNG。
 * 独立离屏 canvas, 无棋盘背景、无手柄/标记, 只包含最终裁剪结果。
 */
import { Renderer, sceneBounds } from './renderer';
import type { SceneModel, ViewMode } from '../core/scene/types';
import { identity, multiply, translation } from '../core/geometry/matrix';

export interface ExportOptions {
  width: number;
  height: number;
  margin?: number;
  mode?: ViewMode;
}

export function buildExportCanvas(scene: SceneModel, options: ExportOptions): HTMLCanvasElement {
  const { width, height } = options;
  const margin = options.margin ?? 24;
  const mode = options.mode ?? 'final';

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const renderer = new Renderer(canvas);
  renderer.dpr = 1;

  const b = sceneBounds(scene);
  const sceneW = Math.max(1, b.maxX - b.minX);
  const sceneH = Math.max(1, b.maxY - b.minY);
  const scale = Math.min((width - margin * 2) / sceneW, (height - margin * 2) / sceneH);
  const centerX = width / 2 - ((b.minX + b.maxX) / 2) * scale;
  const centerY = height / 2 - ((b.minY + b.maxY) / 2) * scale;
  const view = multiply(translation(centerX, centerY), {
    ...identity(),
    a: scale,
    d: scale,
  });

  renderer.render({
    scene,
    view,
    mode,
    active: 'content',
    hit: null,
    hoverHandle: null,
    showChecker: false,
    exportOnly: true,
  });
  return canvas;
}

export function downloadPng(scene: SceneModel, options: ExportOptions): void {
  const canvas = buildExportCanvas(scene, options);
  canvas.toBlob((blob) => {
    if (!blob) throw new Error('PNG 编码失败');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vector-mask-${options.width}x${options.height}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}
