// renderer.js
// Canvas 2D 渲染器。仿真使用 [0,1] 归一化坐标（y 轴向上），
// 渲染时按画布尺寸映射，因此窗口调整不影响仿真结果，只改变显示比例。
// 粒子精灵按色相量化缓存为离屏 canvas，避免每帧创建径向渐变。

const HUE_BUCKETS = 64;
const SPRITE_SIZE = 64;

function makeSprite(hue) {
  const c = document.createElement('canvas');
  c.width = SPRITE_SIZE;
  c.height = SPRITE_SIZE;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(
    SPRITE_SIZE / 2, SPRITE_SIZE / 2, 0,
    SPRITE_SIZE / 2, SPRITE_SIZE / 2, SPRITE_SIZE / 2
  );
  g.addColorStop(0, `hsla(${hue}, 100%, 78%, 1)`);
  g.addColorStop(0.35, `hsla(${hue}, 95%, 58%, 0.55)`);
  g.addColorStop(1, `hsla(${hue}, 95%, 50%, 0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  return c;
}

export class ParticleRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sprites = [];
    this.dpr = 1;
    this.cssWidth = 0;
    this.cssHeight = 0;
    this.resize();
  }

  /** 按设备像素比重建画布位图，CSS 尺寸由布局决定。 */
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w === this.cssWidth && h === this.cssHeight && dpr === this.dpr) return;
    this.dpr = dpr;
    this.cssWidth = w;
    this.cssHeight = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  getSprite(hue) {
    const idx = Math.round(((hue % 360) / 360) * HUE_BUCKETS) % HUE_BUCKETS;
    if (!this.sprites[idx]) {
      this.sprites[idx] = makeSprite(Math.round((idx / HUE_BUCKETS) * 360));
    }
    return this.sprites[idx];
  }

  clear() {
    const { ctx, canvas } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#0b0f17';
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
  }

  drawEmitter() {
    const ctx = this.ctx;
    const x = this.cssWidth * 0.5;
    const y = this.cssHeight * (1 - 0.12);
    ctx.save();
    ctx.fillStyle = '#8ea2c0';
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(142,162,192,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - 14);
    ctx.stroke();
    ctx.restore();
  }

  /** 绘制一个粒子系统。label 用于并排比较时标识 A/B。 */
  draw(system) {
    this.clear();
    const ctx = this.ctx;
    const w = this.cssWidth;
    const h = this.cssHeight;
    const scale = Math.min(w, h);

    ctx.globalCompositeOperation = 'lighter'; // 加色混合，重叠处自然变亮
    for (const p of system.particles) {
      const t = p.age / p.life;
      const alpha = Math.max(0, 1 - t) ** 1.5;
      const hue = system.particleHue(p);
      const sprite = this.getSprite(hue);
      const radius = p.size * scale * (1 + 0.25 * t);
      const sx = p.x * w;
      const sy = (1 - p.y) * h; // 归一化 y 轴向上 -> 屏幕 y 轴向下
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprite, sx - radius, sy - radius, radius * 2, radius * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    this.drawEmitter();
  }
}
