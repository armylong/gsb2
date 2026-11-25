/**
 * 示例路径库。
 * 坐标约定: 全部路径定义在各自的局部坐标系, 屏幕 y 向下,
 * 因此「顺时针 CW」的有向面积为正。
 */
import type { PathCommand, VectorPath } from '../geometry/path';

export class PathBuilder {
  private commands: PathCommand[] = [];

  moveTo(x: number, y: number): this {
    this.commands.push({ type: 'M', x, y });
    return this;
  }

  lineTo(x: number, y: number): this {
    this.commands.push({ type: 'L', x, y });
    return this;
  }

  cubicTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): this {
    this.commands.push({ type: 'C', c1x, c1y, c2x, c2y, c3x: x, c3y: y });
    return this;
  }

  close(): this {
    this.commands.push({ type: 'Z' });
    return this;
  }

  build(): VectorPath {
    return { commands: [...this.commands] };
  }
}

/** 以 (cx, cy) 为中心的矩形; clockwise=true 时在屏幕坐标下顺时针。 */
export function rectPath(cx: number, cy: number, w: number, h: number, clockwise = true): VectorPath {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const y0 = cy - h / 2;
  const y1 = cy + h / 2;
  const b = new PathBuilder();
  if (clockwise) {
    b.moveTo(x0, y0).lineTo(x1, y0).lineTo(x1, y1).lineTo(x0, y1).close();
  } else {
    b.moveTo(x0, y0).lineTo(x0, y1).lineTo(x1, y1).lineTo(x1, y0).close();
  }
  return b.build();
}

/** 圆由 4 段三次贝塞尔近似; clockwise 控制环绕方向(屏幕坐标 y 向下)。 */
export function circlePath(cx: number, cy: number, r: number, clockwise = true): VectorPath {
  const k = 0.5522847498307936 * r;
  const dir = clockwise ? 1 : -1;
  const b = new PathBuilder();
  for (let i = 0; i < 4; i++) {
    const a0 = dir * i * (Math.PI / 2);
    const a1 = dir * (i + 1) * (Math.PI / 2);
    const p0x = cx + r * Math.cos(a0);
    const p0y = cy + r * Math.sin(a0);
    const p3x = cx + r * Math.cos(a1);
    const p3y = cy + r * Math.sin(a1);
    // 行进方向的单位切向量 = dir · (-sin a, cos a)
    const t0x = dir * -Math.sin(a0);
    const t0y = dir * Math.cos(a0);
    const t1x = dir * -Math.sin(a1);
    const t1y = dir * Math.cos(a1);
    if (i === 0) b.moveTo(p0x, p0y);
    b.cubicTo(p0x + k * t0x, p0y + k * t0y, p3x - k * t1x, p3y - k * t1y, p3x, p3y);
  }
  return b.close().build();
}

/**
 * 带孔方块。
 * @param innerClockwise 内孔方向; 与外框相反时 nonzero 也是孔(常规做法),
 *   与外框同向时 nonzero 会把孔填上、只有 evenodd 仍是孔 —— 这就是最容易把填充规则弄反的陷阱。
 */
export function holedSquarePath(innerClockwise: boolean): VectorPath {
  const outer = rectPath(0, 0, 200, 200, true);
  const inner = rectPath(0, 0, 90, 90, innerClockwise);
  return { commands: [...outer.commands, ...inner.commands] };
}

/** 双圆重叠轮廓: 同向时 nonzero 取并集, evenodd 在交叠透镜处镂空。 */
export function overlappingCirclesPath(): VectorPath {
  const c1 = circlePath(-55, 0, 80, true);
  const c2 = circlePath(55, 0, 80, true);
  return { commands: [...c1.commands, ...c2.commands] };
}

/**
 * 五角星折线(pentagram {5/2}): 5 个外顶点按隔点顺序连成的单条自交折线。
 * 中心五边形区域: 射线跨 2 条边 → evenodd 镂空; 两次同向环绕 → nonzero 实心,
 * 是两种填充规则差异最直观的例子。
 */
export function starPath(cx: number, cy: number, outerR: number, points = 5): VectorPath {
  const verts: { x: number; y: number }[] = [];
  for (let i = 0; i < points; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / points;
    verts.push({ x: cx + outerR * Math.cos(angle), y: cy + outerR * Math.sin(angle) });
  }
  const b = new PathBuilder();
  for (let i = 0; i < points; i++) {
    const v = verts[(i * 2) % points];
    if (i === 0) b.moveTo(v.x, v.y);
    else b.lineTo(v.x, v.y);
  }
  return b.close().build();
}

/** 带圆角和曲线的 blob, 用来验证曲线展平与命中精度。 */
export function blobPath(): VectorPath {
  const b = new PathBuilder();
  b.moveTo(-90, -20)
    .cubicTo(-110, -90, -20, -120, 30, -90)
    .cubicTo(90, -55, 110, 10, 60, 55)
    .cubicTo(20, 100, -60, 90, -85, 45)
    .cubicTo(-105, 10, -75, 30, -90, -20)
    .close();
  return b.build();
}

/** 遮罩 A: 大板上开两个孔(外框 CW + 两个内孔 CCW)。 */
export function maskPlateAPath(): VectorPath {
  const outer = rectPath(0, 0, 460, 340, true);
  const hole1 = rectPath(-120, -60, 110, 110, false);
  const hole2 = circlePath(120, 70, 55, false);
  return { commands: [...outer.commands, ...hole1.commands, ...hole2.commands] };
}

/** 遮罩 B: 旋转的小盖板, 中间一个圆孔。 */
export function maskPlateBPath(): VectorPath {
  const outer = rectPath(0, 0, 240, 240, true);
  const hole = circlePath(0, 0, 70, false);
  return { commands: [...outer.commands, ...hole.commands] };
}
