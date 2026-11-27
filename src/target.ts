import { ImageSpec, Sampler } from './project';

export const TARGET_CANVAS_W = 512;
export const TARGET_CANVAS_H = 640;

/**
 * 默认目标图:明显不对称 —— 大字 "R"、左上红块、右侧蓝圆、
 * 左下绿三角、黄色斜条,挪开镜头后容易辨认方向有没有对。
 */
export function drawTargetCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = TARGET_CANVAS_W;
  c.height = TARGET_CANVAS_H;
  const ctx = c.getContext('2d')!;

  ctx.fillStyle = '#f4efe4';
  ctx.fillRect(0, 0, c.width, c.height);

  // 黄色斜条(右上 → 左下)
  ctx.save();
  ctx.translate(c.width * 0.62, c.height * 0.1);
  ctx.rotate(0.5);
  ctx.fillStyle = '#f2c200';
  ctx.fillRect(0, 0, 70, c.height * 0.75);
  ctx.restore();

  // 左上红色块
  ctx.fillStyle = '#d23c2a';
  ctx.fillRect(24, 30, 180, 130);

  // 右侧蓝色圆
  ctx.fillStyle = '#2050c8';
  ctx.beginPath();
  ctx.arc(c.width * 0.78, c.height * 0.52, 78, 0, Math.PI * 2);
  ctx.fill();

  // 左下绿色三角
  ctx.fillStyle = '#1e8a4c';
  ctx.beginPath();
  ctx.moveTo(40, c.height - 40);
  ctx.lineTo(240, c.height - 40);
  ctx.lineTo(40, c.height - 260);
  ctx.closePath();
  ctx.fill();

  // 不对称大字 R
  ctx.fillStyle = '#22222a';
  ctx.font = '900 300px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('R', c.width * 0.44, c.height * 0.52);

  // 顶部小箭头,标记"上"
  ctx.fillStyle = '#22222a';
  ctx.beginPath();
  ctx.moveTo(c.width * 0.5, 14);
  ctx.lineTo(c.width * 0.5 - 16, 44);
  ctx.lineTo(c.width * 0.5 + 16, 44);
  ctx.closePath();
  ctx.fill();

  return c;
}

/** 由画布生成取色器:目标图局部坐标(米)→ css 颜色 */
export function makeSampler(canvas: HTMLCanvasElement, img: ImageSpec): Sampler {
  const ctx = canvas.getContext('2d')!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return (u, v) => {
    const px = Math.min(canvas.width - 1, Math.max(0, Math.floor(((u + img.w / 2) / img.w) * canvas.width)));
    // 图像 v 向上,画布 y 向下
    const py = Math.min(canvas.height - 1, Math.max(0, Math.floor((1 - (v + img.h / 2) / img.h) * canvas.height)));
    const o = (py * canvas.width + px) * 4;
    return `rgb(${data[o]},${data[o + 1]},${data[o + 2]})`;
  };
}
