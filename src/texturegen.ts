/**
 * texturegen.ts —— 程序化生成六面环境图(Canvas,无外部图片)
 *
 * 每面包含:
 *  - 方向名称(+X 右面 等)与规范"上方向"标注 UP
 *  - GRID×GRID 编号网格,格子内标注全局编号 idx=row*GRID+col
 *  - 非对称箭头(右向主箭头 + 偏置尾翼 + 角标),用于肉眼识别旋转/翻转
 *  - 四条边的彩色边带:同一共享边在两个面上颜色相同,带 0..GRID 刻度,
 *    刻度即接缝两侧的对应次序标记
 */

import {
  FACE_ORDER, GRID, FACE_LABEL, FACE_SHORT,
  SHARED_EDGES, edgeColor, faceTint,
  type FaceId, type Side,
} from './facemath';

export const TEX_SIZE = 1024;
const BAND = 64; // 边带宽度(像素)

const edgeColorMap = new Map<string, string>();
for (const se of SHARED_EDGES) {
  edgeColorMap.set(`${se.a.face}:${se.a.side}`, edgeColor(se));
  edgeColorMap.set(`${se.b.face}:${se.b.side}`, edgeColor(se));
}

export function edgeBandColor(face: FaceId, side: Side): string {
  return edgeColorMap.get(`${face}:${side}`) ?? '#888';
}

function drawArrow(ctx: CanvasRenderingContext2D, size: number): void {
  // 非对称箭头:位于面中央,指向规范 r 方向(纹理右方)
  const cx = size / 2;
  const cy = size / 2;
  const L = size * 0.3;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 主轴
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.moveTo(-L * 0.7, 0);
  ctx.lineTo(L * 0.75, 0);
  ctx.stroke();
  // 箭头头部(只有右上侧有羽,强化非对称)
  ctx.beginPath();
  ctx.moveTo(L * 0.75, 0);
  ctx.lineTo(L * 0.4, -L * 0.28);
  ctx.moveTo(L * 0.75, 0);
  ctx.lineTo(L * 0.42, L * 0.1);
  ctx.stroke();
  // 尾翼:只在下方,且只画两道 —— 与头部的不对称呼应
  ctx.lineWidth = 10;
  for (const k of [0, 1]) {
    const x = -L * (0.55 - k * 0.22);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x - L * 0.12, L * 0.2);
    ctx.stroke();
  }
  // 左上角小圆点(第四个非对称特征,翻转后会跑到右上角)
  ctx.fillStyle = '#d23';
  ctx.beginPath();
  ctx.arc(-L * 0.75, -L * 0.55, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function generateFaceCanvas(face: FaceId): HTMLCanvasElement {
  const size = TEX_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // 底色
  ctx.fillStyle = faceTint(face);
  ctx.fillRect(0, 0, size, size);

  // 边带(先画,网格线压在上面)
  const sides: Side[] = ['left', 'right', 'top', 'bottom'];
  for (const side of sides) {
    ctx.fillStyle = edgeBandColor(face, side);
    ctx.globalAlpha = 0.85;
    if (side === 'left') ctx.fillRect(0, 0, BAND, size);
    if (side === 'right') ctx.fillRect(size - BAND, 0, BAND, size);
    if (side === 'top') ctx.fillRect(0, 0, size, BAND);
    if (side === 'bottom') ctx.fillRect(0, size - BAND, size, BAND);
    ctx.globalAlpha = 1;
  }

  // 网格
  const inner = size - BAND * 2;
  const cell = inner / GRID;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= GRID; i++) {
    const p = BAND + i * cell;
    ctx.beginPath(); ctx.moveTo(p, BAND); ctx.lineTo(p, size - BAND); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(BAND, p); ctx.lineTo(size - BAND, p); ctx.stroke();
  }

  // 格子编号
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.font = `${Math.round(cell * 0.26)}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const idx = row * GRID + col;
      ctx.fillText(String(idx), BAND + (col + 0.5) * cell, BAND + (row + 0.5) * cell);
    }
  }

  // 非对称箭头(半透明,不遮编号)
  ctx.globalAlpha = 0.28;
  drawArrow(ctx, size);
  ctx.globalAlpha = 1;

  // 边带刻度与刻度号(白色描边保证任何底色上可读)
  ctx.font = `bold ${Math.round(BAND * 0.32)}px ui-monospace, monospace`;
  const drawTicks = (side: Side): void => {
    for (let t = 0; t <= GRID; t++) {
      const p = BAND + (t / GRID) * inner;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 4;
      ctx.beginPath();
      if (side === 'left') { ctx.moveTo(0, p); ctx.lineTo(BAND * 0.7, p); }
      if (side === 'right') { ctx.moveTo(size, p); ctx.lineTo(size - BAND * 0.7, p); }
      if (side === 'top') { ctx.moveTo(p, 0); ctx.lineTo(p, BAND * 0.7); }
      if (side === 'bottom') { ctx.moveTo(p, size); ctx.lineTo(p, size - BAND * 0.7); }
      ctx.stroke();
      if (t < GRID) {
        const lp = BAND + (t + 0.5) * cell;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.fillStyle = '#fff';
        ctx.strokeText(String(t), side === 'left' || side === 'right'
          ? (side === 'left' ? BAND * 0.42 : size - BAND * 0.42)
          : lp,
          side === 'left' || side === 'right'
            ? lp
            : (side === 'top' ? BAND * 0.42 : size - BAND * 0.42));
        ctx.fillText(String(t), side === 'left' || side === 'right'
          ? (side === 'left' ? BAND * 0.42 : size - BAND * 0.42)
          : lp,
          side === 'left' || side === 'right'
            ? lp
            : (side === 'top' ? BAND * 0.42 : size - BAND * 0.42));
      }
    }
  };
  for (const side of sides) drawTicks(side);

  // 面名与 UP 标注(顶部通栏文字,带白底保证可读)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(size * 0.052)}px system-ui, sans-serif`;
  const title = `${FACE_SHORT[face]}  ${FACE_LABEL[face].split(' ')[1] ?? ''}`;
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.fillStyle = '#111';
  ctx.strokeText(title, size / 2, BAND * 0.55);
  ctx.fillText(title, size / 2, BAND * 0.55);

  // UP 角标:明确该面的规范上方向
  ctx.font = `bold ${Math.round(BAND * 0.4)}px system-ui, sans-serif`;
  ctx.strokeText('▲UP', size / 2, BAND * 1.35);
  ctx.fillText('▲UP', size / 2, BAND * 1.35);

  // 右下角面短名(翻转检查用)
  ctx.font = `bold ${Math.round(BAND * 0.45)}px ui-monospace, monospace`;
  ctx.strokeText(FACE_SHORT[face], size - BAND * 1.1, size - BAND * 0.8);
  ctx.fillText(FACE_SHORT[face], size - BAND * 1.1, size - BAND * 0.8);

  return canvas;
}

export function generateAllFaces(): Record<FaceId, HTMLCanvasElement> {
  const out = {} as Record<FaceId, HTMLCanvasElement>;
  for (const face of FACE_ORDER) out[face] = generateFaceCanvas(face);
  return out;
}
