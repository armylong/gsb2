/**
 * 全部纹理程序生成，无外部素材。
 * 带面纹理沿弧长方向布局：u = 材料坐标 s / L，走带时只改 texture.offset.x。
 */
import * as THREE from 'three';

export const BELF_TEX_W = 2048;
export const BELT_TEX_H = 256;

/** 带面纹理：橡胶底色 + 固定间距刻度 + 不对称箭头 + 接缝拉链纹 */
export function makeBeltTexture(length: number, spacing: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = BELF_TEX_W;
  canvas.height = BELT_TEX_H;
  const ctx = canvas.getContext('2d')!;

  // 底色：提亮，保证刻度与箭头在默认光照下清晰
  const grad = ctx.createLinearGradient(0, 0, 0, BELT_TEX_H);
  grad.addColorStop(0, '#4a5260');
  grad.addColorStop(0.5, '#3b424e');
  grad.addColorStop(1, '#4a5260');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, BELF_TEX_W, BELT_TEX_H);

  // 两侧边条
  ctx.fillStyle = '#5d6775';
  ctx.fillRect(0, 0, BELF_TEX_W, 18);
  ctx.fillRect(0, BELT_TEX_H - 18, BELF_TEX_W, 18);

  const pxPerUnit = BELF_TEX_W / length;
  const count = Math.floor(length / spacing);

  // 刻度：每 spacing 一条，每 5 条加长加粗
  for (let k = 0; k < count; k++) {
    const x = (k * spacing * pxPerUnit) % BELF_TEX_W;
    const major = k % 5 === 0;
    ctx.strokeStyle = major ? '#ffd96b' : '#cdd6e4';
    ctx.lineWidth = major ? 5 : 3;
    ctx.beginPath();
    ctx.moveTo(x, major ? 26 : 44);
    ctx.lineTo(x, BELT_TEX_H - (major ? 26 : 44));
    ctx.stroke();
  }

  // 前后不对称标志：箭头指向 s 增大方向，每 3 个间距一个，落在两刻度之间
  for (let k = 0; k < count; k++) {
    if (k % 3 !== 1) continue;
    const cx = ((k * spacing + spacing * 0.5) * pxPerUnit) % BELF_TEX_W;
    const cy = BELT_TEX_H / 2;
    const s = 30;
    ctx.fillStyle = '#7fd0f0';
    ctx.beginPath();
    // 不对称箭头：头部三角 + 偏置短尾，镜像可辨方向
    ctx.moveTo(cx + s * 0.9, cy);
    ctx.lineTo(cx - s * 0.5, cy - s * 0.62);
    ctx.lineTo(cx - s * 0.15, cy);
    ctx.lineTo(cx - s * 0.5, cy + s * 0.62);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(cx - s * 1.05, cy - 5, s * 0.4, 10);
  }

  // 接缝（材料坐标 s=0，即 u=0）：亮色拉链纹，跨整条带宽
  const seamW = Math.max(10, 0.12 * pxPerUnit);
  ctx.fillStyle = '#ff7a59';
  ctx.fillRect(0, 0, seamW, BELT_TEX_H);
  ctx.strokeStyle = '#ffd2c4';
  ctx.lineWidth = 3;
  for (let y = 10; y < BELT_TEX_H; y += 22) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(seamW + 6, y + 11);
    ctx.stroke();
  }
  // 接缝在重复边界另一侧也补一半，保证 wrap 时连续
  ctx.fillStyle = '#ff7a59';
  ctx.fillRect(BELF_TEX_W - seamW, 0, seamW, BELT_TEX_H);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** 数字徽章纹理（编号刻度与选中态） */
export function makeBadgeTexture(label: string, selected: boolean): THREE.CanvasTexture {
  const size = 160;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);

  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
  ctx.fillStyle = selected ? '#f5b942' : '#1f2530';
  ctx.fill();
  ctx.lineWidth = selected ? 10 : 6;
  ctx.strokeStyle = selected ? '#fff3d6' : '#6fb7d6';
  ctx.stroke();

  ctx.fillStyle = selected ? '#1f2530' : '#e8edf5';
  ctx.font = `bold ${label.length > 2 ? 44 : 58}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, size / 2, size / 2 + 4);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 纯文字标签（轮编号等） */
export function makeLabelTexture(text: string, color = '#dfe6f0'): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = color;
  ctx.font = 'bold 84px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 68);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
