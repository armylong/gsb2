/**
 * 颜色合成的数学口径(与渲染管线完全一致):
 *
 * - 颜色一律用线性 0..1 的 RGB 三元组表达。为了让演示数值直观、可复算,
 *   本演示关闭 three.js 的颜色管理(THREE.ColorManagement.enabled = false),
 *   面板上选的颜色值原样进入渲染目标,不做 sRGB 线性化转换,
 *   因此这里的 over 混合也是直接在该数值空间进行(直色 straight alpha)。
 * - 合成采用标准 source-over(Porter-Duff "over"):
 *       C_out = α_s * C_s + (1 - α_s) * C_b
 *       α_out = α_s + (1 - α_s) * α_b
 *   从后向前(back-to-front)逐面叠加。
 * - 不透明表面(α=1)直接重置累积颜色,等于完全遮住后方。
 */

export interface Fragment {
  /** 物体 id,用于检查点报告 */
  id: string;
  /** 显示名 */
  name: string;
  /** 0..1 RGB(直色) */
  color: [number, number, number];
  /** 0..1 不透明度 */
  alpha: number;
  /** 相机空间深度(沿 -Z 方向的距离,值越大离相机越远) */
  depth: number;
  /** 是否不透明挡板 */
  opaque: boolean;
}

export interface CompositeResult {
  /** 最终颜色,0..1 RGB */
  color: [number, number, number];
  /** 实际参与合成的片元,按从近到远(front-to-back)排列 */
  ordered: Fragment[];
  /** 被更靠前表面挡住、未参与合成的片元 */
  occluded: Fragment[];
}

/** 单次 source-over:src 覆盖在 dst 之上 */
export function alphaOver(
  dst: [number, number, number],
  src: [number, number, number],
  alpha: number,
): [number, number, number] {
  return [
    alpha * src[0] + (1 - alpha) * dst[0],
    alpha * src[1] + (1 - alpha) * dst[1],
    alpha * src[2] + (1 - alpha) * dst[2],
  ];
}

/**
 * 按真实前后关系合成一束片元(正确模式的参考实现)。
 *
 * 步骤:
 * 1. 按深度从近到远排序(相机空间深度小者在前);
 * 2. 遇到不透明表面:它成为新的底色,其后的一切全部丢弃;
 * 3. 从最靠后的可见片元开始,从后向前做 alpha-over。
 */
export function compositeFragments(
  fragments: Fragment[],
  background: [number, number, number],
): CompositeResult {
  // 确定性排序:深度小者在前;深度相等时按 id 打破平局,
  // 使结果与输入(添加)顺序完全无关。
  // shader 中平局按层序号稳定,而层序号与预设表面数组一致,在本演示的 id 字典序下相同。
  const indexed = fragments.map((f, i) => ({ f, i }));
  indexed.sort((a, b) => {
    if (a.f.depth !== b.f.depth) return a.f.depth - b.f.depth;
    if (a.f.id !== b.f.id) return a.f.id < b.f.id ? -1 : 1;
    return a.i - b.i;
  });
  const sorted = indexed.map((x) => x.f);

  // 找到最靠前的不透明表面:它与它之前的透明面可见,其后的一切全部丢弃。
  // 透明面 alpha=1 时同样完全不透明(需求:α=1 完全遮住后方),按同一规则截断。
  const isOpaque = (f: Fragment): boolean => f.opaque || f.alpha >= 1;
  const firstOpaque = sorted.findIndex(isOpaque);
  const visible = firstOpaque === -1 ? sorted : sorted.slice(0, firstOpaque + 1);
  const occluded = firstOpaque === -1 ? [] : sorted.slice(firstOpaque + 1);

  // 从后向前 source-over
  let color: [number, number, number] = [...background];
  for (let i = visible.length - 1; i >= 0; i--) {
    const f = visible[i];
    color = isOpaque(f) ? [...f.color] : alphaOver(color, f.color, f.alpha);
  }

  return { color, ordered: visible, occluded };
}

/**
 * 物体级排序混合(普通/手动模式的参考实现)。
 *
 * drawOrder 是物体的绘制先后顺序(数组先绘制的在最底层)。
 * 每个物体只贡献一次混合,无法表达同一像素上逐像素的深度翻转——
 * 这正是交叉面场景中普通排序出错的数学原因。
 * 不透明物体同样按绘制顺序处理;真实管线里不透明物体先画且写深度,
 * 这里用"不透明表面截断后续片元"来等价表达挡板遮挡。
 */
export function compositeByDrawOrder(
  fragments: Fragment[],
  drawOrder: string[],
  background: [number, number, number],
): CompositeResult {
  const rank = new Map(drawOrder.map((id, i) => [id, i]));
  // 先画(底层) -> 后画(上层)
  const ordered = [...fragments].sort(
    (a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0),
  );

  let color: [number, number, number] = [...background];
  const used: Fragment[] = [];
  const skipped: Fragment[] = [];
  let blocked = false;
  for (const f of ordered) {
    if (blocked) {
      skipped.push(f);
      continue;
    }
    used.push(f);
    if (f.opaque) {
      color = [...f.color];
      blocked = true;
    } else {
      color = alphaOver(color, f.color, f.alpha);
    }
  }
  return { color, ordered: used, occluded: skipped };
}

/** 0..1 浮点转 0..255 并四舍五入 */
export function toByte(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

export function colorToBytes(c: [number, number, number]): [number, number, number] {
  return [toByte(c[0]), toByte(c[1]), toByte(c[2])];
}

/**
 * 两个字节色(0..255 RGB)的每通道绝对差,返回最大差值。
 * 注意:两个入参都必须是 0..255 口径,不要传 0..1 浮点色。
 */
export function maxChannelError(
  observed: [number, number, number],
  expectedBytes: [number, number, number],
): number {
  return Math.max(
    Math.abs(observed[0] - expectedBytes[0]),
    Math.abs(observed[1] - expectedBytes[1]),
    Math.abs(observed[2] - expectedBytes[2]),
  );
}
