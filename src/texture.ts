/**
 * 把程序高度场烘成法线贴图 CanvasTexture（OpenGL 约定）。
 * 仅页面使用；验证脚本走 CPU 的 normalAt，同一份数学。
 */
import * as THREE from 'three';
import { normalAt } from './core/heightfield';

export function makeNormalMapTexture(size = 512): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = 1 - y / size; // canvas y 向下，v 向上
      const n = normalAt(u, v);
      const i = (y * size + x) * 4;
      img.data[i] = Math.round((n[0] * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round((n[1] * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round((n[2] * 0.5 + 0.5) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace; // 法线数据不做色彩空间转换
  return tex;
}
