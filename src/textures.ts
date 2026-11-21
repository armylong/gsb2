import * as THREE from 'three';

/**
 * 全部纹理由程序生成（无外部资源）：
 * 1. buildDiagnosticTexture —— 诊断纹理：网格 + 带方向的文字 + 旋转色标，
 *    每个轴在采样点处都能读出方向和坐标；
 * 2. buildWeightsLUT —— 权重可视化查找表：t=|n|^s 映射成颜色，
 *    着色器在“权重可视化”模式下按每轴原始权重取色。
 */

export const TEXTURE_SIZE = 512;

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  return [canvas, ctx];
}

/** 画一个带描边的箭头，标明该轴平面的 u/v 方向 */
function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, color: string, label: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-46, 0);
  ctx.lineTo(40, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(40, 0);
  ctx.lineTo(22, -14);
  ctx.lineTo(22, 14);
  ctx.closePath();
  ctx.fill();
  ctx.rotate(-angle);
  ctx.font = 'bold 30px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 52, 0);
  ctx.restore();
}

/**
 * 诊断纹理：每格 64px（即世界坐标 1 个单位一格，配合 uvScale=1）。
 * axisTag 会写进每个格子：X / Y / Z，外加 u→ / v→ 方向箭头和
 * 角上的旋转色标（R→G→B→Y），翻转镜像一眼可辨。
 */
export function buildDiagnosticTexture(axisTag: string): THREE.CanvasTexture {
  const size = TEXTURE_SIZE;
  const cell = 64;
  const [canvas, ctx] = makeCanvas(size);

  // 深色底
  ctx.fillStyle = '#101418';
  ctx.fillRect(0, 0, size, size);

  // 角标：顺时针 R G B Y，用来识别旋转/镜像
  const corners: Array<[number, number, string]> = [
    [0, 0, '#ff4d4d'],
    [size, 0, '#4dff88'],
    [size, size, '#4d9fff'],
    [0, size, '#ffe14d'],
  ];
  for (const [cx, cy, color] of corners) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, 26, 0, Math.PI * 2);
    ctx.fill();
  }

  // 网格：主格 64px 亮线，半格 32px 暗线
  for (let p = 0; p <= size; p += cell / 2) {
    const major = p % cell === 0;
    ctx.strokeStyle = major ? '#9fd8ff' : 'rgba(159,216,255,0.22)';
    ctx.lineWidth = major ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(p + 0.5, 0);
    ctx.lineTo(p + 0.5, size);
    ctx.moveTo(0, p + 0.5);
    ctx.lineTo(size, p + 0.5);
    ctx.stroke();
  }

  // 每个格子写轴名 + 整数坐标，并画 u/v 方向箭头
  ctx.textAlign = 'center';
  for (let gx = 0; gx < size / cell; gx++) {
    for (let gy = 0; gy < size / cell; gy++) {
      const x = gx * cell;
      const y = gy * cell;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = 'bold 22px monospace';
      ctx.fillText(axisTag, x + cell / 2, y + 26);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '15px monospace';
      ctx.fillText(`u${gx} v${gy}`, x + cell / 2, y + cell - 10);

      // 仅在中心格画箭头，避免过密
      if (gx === 3 && gy === 3) {
        arrow(ctx, x + 22, y + cell / 2, 0, '#ff8a5c', 'u');
        arrow(ctx, x + cell / 2, y + cell - 22, -Math.PI / 2, '#5cd6ff', 'v');
      }
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // 原始 ShaderMaterial 不经过内置的 colorspace 解码块，
  // 用 NoColorSpace 保证 shader 采样到的就是画布原色。
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * 权重可视化 1D LUT（存成 16x1 纹理）。
 * t=0 深蓝 → 青 → 绿 → 黄 → t=1 红，
 * 着色器按每轴的“原始（未归一化）权重”查色，直接显示 |n|^s 的分布。
 */
export function buildWeightsLUT(): THREE.DataTexture {
  const n = 256;
  const data = new Uint8Array(n * 4);
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [20, 30, 90]],
    [0.25, [30, 130, 200]],
    [0.5, [40, 200, 140]],
    [0.75, [240, 210, 50]],
    [1.0, [240, 60, 50]],
  ];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let lo = stops[0];
    let hi = stops[stops.length - 1];
    for (let k = 0; k < stops.length - 1; k++) {
      if (t >= stops[k][0] && t <= stops[k + 1][0]) {
        lo = stops[k];
        hi = stops[k + 1];
        break;
      }
    }
    const f = (t - lo[0]) / (hi[0] - lo[0] || 1);
    data[i * 4 + 0] = lo[1][0] + (hi[1][0] - lo[1][0]) * f;
    data[i * 4 + 1] = lo[1][1] + (hi[1][1] - lo[1][1]) * f;
    data[i * 4 + 2] = lo[1][2] + (hi[1][2] - lo[1][2]) * f;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}
