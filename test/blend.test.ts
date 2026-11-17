import { describe, it, expect } from 'vitest';
import {
  alphaOver,
  compositeFragments,
  compositeByDrawOrder,
  type Fragment,
} from '../src/blend';

function frag(
  id: string,
  depth: number,
  color: [number, number, number],
  alpha: number,
  opaque = false,
): Fragment {
  return { id, name: id, depth, color, alpha, opaque };
}

const BG: [number, number, number] = [0.1, 0.1, 0.1];

describe('source-over 混合数学', () => {
  it('alpha=0 的片元不改变后方颜色(透明端点)', () => {
    const dst: [number, number, number] = [0.2, 0.4, 0.8];
    const out = alphaOver(dst, [1, 0, 0], 0);
    expect(out[0]).toBeCloseTo(dst[0], 6);
    expect(out[1]).toBeCloseTo(dst[1], 6);
    expect(out[2]).toBeCloseTo(dst[2], 6);
  });

  it('alpha=1 的片元完全遮住后方(不透明端点)', () => {
    const out = alphaOver([0.2, 0.4, 0.8], [1, 0.5, 0], 1);
    expect(out).toEqual([1, 0.5, 0]);
  });

  it('0.5 叠色等于前后各占一半', () => {
    const out = alphaOver([0, 0, 1], [1, 0, 0], 0.5);
    expect(out.map((v) => Math.round(v * 1000))).toEqual([500, 0, 500]);
  });
});

describe('正确合成:按真实深度排序', () => {
  const far = frag('far', 5, [0, 0, 1], 0.55);
  const near = frag('near', 2, [1, 0, 0], 0.55);

  it('与输入(添加)顺序无关,交换后结果一致', () => {
    const r1 = compositeFragments([near, far], BG);
    const r2 = compositeFragments([far, near], BG);
    expect(r1.color).toEqual(r2.color);
    // 排序结果永远是 near 在前
    expect(r1.ordered.map((f) => f.id)).toEqual(['near', 'far']);
    expect(r2.ordered.map((f) => f.id)).toEqual(['near', 'far']);
  });

  it('不透明表面截断其后方的所有片元', () => {
    const board = frag('board', 3, [0.6, 0.6, 0.6], 1, true);
    const r = compositeFragments([near, board, far], BG);
    expect(r.occluded.map((f) => f.id)).toEqual(['far']);
    expect(r.ordered.map((f) => f.id)).toEqual(['near', 'board']);
    // 最终色只由 near 叠 board 决定,与 far 无关
    const withoutFar = compositeFragments([near, board], BG);
    expect(r.color).toEqual(withoutFar.color);
  });

  it('透明度两端点:0 透出背景,1 遮住背景', () => {
    const clear = frag('c', 2, [1, 0, 0], 0);
    const solid = frag('s', 2, [1, 0, 0], 1);
    expect(compositeFragments([clear], BG).color).toEqual([...BG]);
    expect(compositeFragments([solid], BG).color).toEqual([1, 0, 0]);
  });
});

describe('物体级/手动绘制顺序的对照', () => {
  // 模拟交叉面:像素 A 上 orange 近、teal 远;像素 B 上反过来。
  const a: Fragment[] = [
    frag('orange', 2, [1, 0.6, 0.1], 0.55),
    frag('teal', 4, [0.1, 0.8, 0.7], 0.55),
  ];
  const b: Fragment[] = [
    frag('teal', 2, [0.1, 0.8, 0.7], 0.55),
    frag('orange', 4, [1, 0.6, 0.1], 0.55),
  ];

  it('正确模式在交线两侧给出不同的、各自符合深度的颜色', () => {
    const ra = compositeFragments(a, BG);
    const rb = compositeFragments(b, BG);
    expect(ra.color).not.toEqual(rb.color);
    // 两侧的正确结果应与"按该侧真实次序绘制"一致(先画远的、后画近的)
    const refA = compositeByDrawOrder(a, ['teal', 'orange'], BG); // 像素 A:teal 远先画
    const refB = compositeByDrawOrder(b, ['orange', 'teal'], BG); // 像素 B:orange 远先画
    expect(ra.color).toEqual(refA.color);
    expect(rb.color).toEqual(refB.color);
  });

  it('单一绘制顺序无法同时正确:固定 orange 先画时,必有一侧与正确值不符', () => {
    // orange 先画 = orange 永远在底层。像素 A 上 orange 本应在顶层 → 该侧出错
    const order = ['orange', 'teal'];
    const wrongA = compositeByDrawOrder(a, order, BG);
    const correctA = compositeFragments(a, BG);
    expect(wrongA.color).not.toEqual(correctA.color);
    // 像素 B 上 orange 确实在底层 → 该侧恰好正确
    const rightB = compositeByDrawOrder(b, order, BG);
    expect(rightB.color).toEqual(compositeFragments(b, BG).color);
  });

  it('手动交换顺序后,正确模式结果保持一致(对照模式才变)', () => {
    // 像素 A:真实次序 orange 近(顶层)、teal 远(底层)
    const correct = compositeFragments(a, BG).color;
    const rightOrder = ['teal', 'orange']; // 先画远的 → 与正确值一致
    const swappedOrder = ['orange', 'teal']; // 交换后 → 与正确值不符
    const m1 = compositeByDrawOrder(a, rightOrder, BG).color;
    const m2 = compositeByDrawOrder(a, swappedOrder, BG).color;
    expect(m1).not.toEqual(m2); // 手动模式:顺序变,结果变
    expect(m1).toEqual(correct);
    expect(m2).not.toEqual(correct);
    // 正确模式:无论怎么"交换添加顺序"都不变
    expect(compositeFragments([...a].reverse(), BG).color).toEqual(correct);
  });
});
