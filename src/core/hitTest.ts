/**
 * 命中测试真值层。
 *
 * 与渲染共用 geometry/path 的同一份展平几何, 坐标链:
 *   设备像素 --invert(view)--> 场景根
 *     --invert(contentMatrix)--> 内容局部
 *     --invert(A.matrix)------> A 局部
 *     --invert(A·B)----------> B 局部
 *
 * 遮罩有效性按「与」组合: 父层 A 裁掉的点, 子层 B 无论如何都不能重新打开。
 */
import type { FillProbe, FillRule, Vec2 } from './geometry/path';
import { fillRuleAt } from './geometry/path';
import { apply, invert, multiply } from './geometry/matrix';
import type { ContentShape, MaskKey, SceneModel } from './scene/types';

export interface MaskProbeInfo {
  key: MaskKey;
  rule: FillRule;
  /** 探测点在该遮罩局部坐标系中的位置 */
  localPoint: Vec2;
  probe: FillProbe;
  /** 实际渲染中该遮罩在此点是否放行(boundary 与 inside 同样视为放行) */
  passes: boolean;
}

export interface HitResult {
  pointRoot: Vec2;
  pointContent: Vec2;
  /** 几何上最上层的命中图形(不考虑遮罩) */
  shape: ContentShape | null;
  shapeProbe: FillProbe | null;
  /** 两层遮罩都放行后, 画面上实际可见的最上层图形 */
  visibleShape: ContentShape | null;
  masks: Record<MaskKey, MaskProbeInfo>;
  /** 点中了图形且两层遮罩都放行 —— 即画面上真正可见、可点的像素 */
  visible: boolean;
}

export function probeMask(scene: SceneModel, key: MaskKey, rootPoint: Vec2): MaskProbeInfo {
  const mask = scene.masks[key];
  const localToRoot =
    key === 'A' ? mask.matrix : multiply(scene.masks.A.matrix, mask.matrix);
  const localPoint = apply(invert(localToRoot), rootPoint);
  const probe = fillRuleAt(mask.path, localPoint, mask.rule);
  return {
    key,
    rule: mask.rule,
    localPoint,
    probe,
    passes: probe.verdict !== 'outside',
  };
}

export function hitTest(scene: SceneModel, rootPoint: Vec2): HitResult {
  const pointContent = apply(invert(scene.contentMatrix), rootPoint);

  const masks = {
    A: probeMask(scene, 'A', rootPoint),
    B: probeMask(scene, 'B', rootPoint),
  };
  const masksPass = masks.A.passes && masks.B.passes;

  // 自顶向下: 记录第一个几何命中, 以及第一个在遮罩放行区内的命中
  const ordered = [...scene.shapes].sort((s1, s2) => s2.z - s1.z);
  let topShape: ContentShape | null = null;
  let topProbe: FillProbe | null = null;
  let visibleShape: ContentShape | null = null;
  for (const shape of ordered) {
    const probe = fillRuleAt(shape.path, pointContent, shape.rule);
    if (probe.verdict === 'outside') continue;
    if (!topShape) {
      topShape = shape;
      topProbe = probe;
    }
    if (masksPass && !visibleShape) visibleShape = shape;
  }

  return {
    pointRoot: rootPoint,
    pointContent,
    shape: topShape,
    shapeProbe: topProbe,
    visibleShape,
    masks,
    visible: visibleShape !== null,
  };
}
