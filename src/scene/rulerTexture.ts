import * as THREE from 'three';
import { BACK_RULER, FRONT_RULER } from '../physics/geometry';

/**
 * 程序化刻度纹理：1cm 细网格 + 5cm 粗网格 + 数字标注。
 * 后标尺为整面网格板，前标尺为竖直刻度条。
 */
function drawGrid(opts: {
  widthCm: number;
  heightCm: number;
  zeroX: number; // x=0 在画布上的 cm 坐标
  labelPrefix: string;
}): THREE.CanvasTexture {
  const pxPerCm = 24;
  const w = Math.round(opts.widthCm * pxPerCm);
  const h = Math.round(opts.heightCm * pxPerCm);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  // 背景
  ctx.fillStyle = '#101d30';
  ctx.fillRect(0, 0, w, h);

  const toPx = (x: number, y: number): [number, number] => [
    (x + opts.zeroX) * pxPerCm,
    h - y * pxPerCm,
  ];

  // 1cm 细网格
  ctx.strokeStyle = 'rgba(79, 195, 247, 0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= opts.widthCm; x++) {
    const [px] = toPx(x - opts.zeroX, 0);
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
  }
  for (let y = 0; y <= opts.heightCm; y++) {
    const [, py] = toPx(0, y);
    ctx.moveTo(0, py);
    ctx.lineTo(w, py);
  }
  ctx.stroke();

  // 5cm 粗网格 + 数字
  ctx.strokeStyle = 'rgba(79, 195, 247, 0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= opts.widthCm; x += 5) {
    const [px] = toPx(x - opts.zeroX, 0);
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
  }
  for (let y = 0; y <= opts.heightCm; y += 5) {
    const [, py] = toPx(0, y);
    ctx.moveTo(0, py);
    ctx.lineTo(w, py);
  }
  ctx.stroke();

  // 零轴（x=0 / y=0）高亮
  ctx.strokeStyle = '#ffd54f';
  ctx.lineWidth = 2.5;
  const [zx] = toPx(0, 0);
  const [, zy] = toPx(0, 0);
  ctx.beginPath();
  ctx.moveTo(zx, 0);
  ctx.lineTo(zx, h);
  ctx.moveTo(0, zy);
  ctx.lineTo(w, zy);
  ctx.stroke();

  // 数字标注
  ctx.fillStyle = '#b3d7f0';
  ctx.font = '600 18px ui-monospace, monospace';
  ctx.textAlign = 'center';
  for (let x = 0; x <= opts.widthCm; x += 5) {
    const [px] = toPx(x - opts.zeroX, 0);
    const label = `${x - opts.zeroX}`;
    ctx.fillText(label, px, h - 6);
  }
  ctx.textAlign = 'left';
  for (let y = 5; y <= opts.heightCm; y += 5) {
    const [, py] = toPx(0, y);
    ctx.fillText(`${y}`, 6, py - 4);
  }

  ctx.fillStyle = '#8aa0bd';
  ctx.font = '600 20px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(opts.labelPrefix, w - 10, 26);
  ctx.font = '13px sans-serif';
  ctx.fillText('单位 cm · 网格间距 1cm', w - 10, 46);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function createBackRulerMesh(): THREE.Mesh {
  const width = BACK_RULER.x1 - BACK_RULER.x0;
  const height = BACK_RULER.y1 - BACK_RULER.y0;
  const tex = drawGrid({
    widthCm: width,
    heightCm: height,
    zeroX: width / 2,
    labelPrefix: '后标尺（槽后网格板）',
  });
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
  mesh.position.set((BACK_RULER.x0 + BACK_RULER.x1) / 2, (BACK_RULER.y0 + BACK_RULER.y1) / 2, BACK_RULER.z);
  mesh.name = '后标尺';
  mesh.userData.rulerId = 'back';
  return mesh;
}

export function createFrontRulerMesh(): THREE.Mesh {
  const width = FRONT_RULER.x1 - FRONT_RULER.x0;
  const height = FRONT_RULER.y1 - FRONT_RULER.y0;
  const tex = drawGrid({
    widthCm: width,
    heightCm: height,
    zeroX: 0, // 前标尺只关注 y 刻度
    labelPrefix: '前标尺',
  });
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
  mesh.position.set((FRONT_RULER.x0 + FRONT_RULER.x1) / 2, (FRONT_RULER.y0 + FRONT_RULER.y1) / 2, FRONT_RULER.z);
  mesh.name = '前标尺';
  mesh.userData.rulerId = 'front';
  return mesh;
}
