import { visibleWorldRect, type Camera, type WorldRect } from './camera';
import type { BlendMode, Sprite } from './types';

/** 批次开始的原因。层或混合不同都必须切段，才能保持覆盖次序。 */
export type CutReason = 'scene-start' | 'layer-switch' | 'blend-switch';

export interface Batch {
  /** 全局批次序号（与绘制次序一致）。 */
  index: number;
  /** 在 paintOrder 中的起始下标与实例数。 */
  first: number;
  count: number;
  layer: number;
  blend: BlendMode;
  cut: CutReason;
  /** 上一批次；场景第一个批次为 null。 */
  prevBatch: number | null;
}

/** 渲染器要的一段连续实例。 */
export interface DrawGroup {
  first: number;
  count: number;
  blend: BlendMode;
}

/** 同一层里本可连成一批、却被另一混合的精灵夹断的两段。 */
export interface Interruption {
  before: number;
  after: number;
  /** 夹在中间、导致切段的批次。 */
  between: number[];
  /** 夹在中间的精灵标签（最多 4 个 + 省略号），便于看出是谁打断的。 */
  interrupters: string[];
  /** 夹断者里是否含可拖动探针（用户亲手制造的夹断）。 */
  viaProbe: boolean;
  layer: number;
  blend: BlendMode;
}

export interface LayerSpan {
  layer: number;
  first: number;
  count: number;
  batches: number[];
}

export interface BatchPlan {
  /** 入镜精灵在精灵数组中的下标，按画家顺序（层→层内次序）排列。 */
  paintOrder: number[];
  visible: number[];
  culled: number[];
  batches: Batch[];
  /** 每个精灵所属批次；被剔除的为 -1。 */
  batchOfSprite: Int32Array;
  /** 每个精灵在绘制次序中的位次；被剔除的为 -1。 */
  rankOfSprite: Int32Array;
  layerSpans: LayerSpan[];
  interruptions: Interruption[];
  /** 每个批次是否参与某次"夹断"。 */
  interruptedBatch: boolean[];
  counts: {
    total: number;
    visible: number;
    culled: number;
    batches: number;
    blendBreaks: number;
    layerBreaks: number;
    /** 被另一种混合夹断造成的"本可合并"次数。 */
    interruptedPairs: number;
    /** 其中由可拖动探针直接造成的夹断对数。 */
    probeInterruptedPairs: number;
    spritesByBlend: Record<BlendMode, number>;
    batchesByBlend: Record<BlendMode, number>;
  };
  /** 世界空间可见矩形，用于 UI 显示。 */
  viewRect: WorldRect;
  /** 是否按"同层内混合优先"重排（反例诊断，会破坏可见次序）。 */
  reordered: boolean;
}

export interface BuildPlanOptions {
  /**
   * 反例诊断：同层内先按混合设置分组再绘制，批次更少，
   * 但把"夹心"两侧的前后关系拉平了 —— 覆盖结果会与逐个绘制不同。
   * 默认关闭。
   */
  reorderWithinLayer?: boolean;
}

export function spriteRect(sprite: Sprite): WorldRect {
  const halfW = sprite.w / 2;
  const halfH = sprite.h / 2;
  return {
    minX: sprite.x - halfW,
    minY: sprite.y - halfH,
    maxX: sprite.x + halfW,
    maxY: sprite.y + halfH,
  };
}

export function spriteIsOnScreen(
  sprite: Sprite,
  camera: Camera,
  eyeW: number,
  eyeH: number,
  viewRect: WorldRect = visibleWorldRect(camera, eyeW, eyeH),
): boolean {
  const r = spriteRect(sprite);
  return r.minX <= viewRect.maxX && r.maxX >= viewRect.minX && r.minY <= viewRect.maxY && r.maxY >= viewRect.minY;
}

/**
 * 核心不变量：
 *   1. 先按 (层, 层内次序) 得到唯一确定的画家顺序；
 *   2. 批次只能是这条顺序里「层相同、混合相同」的连续一段。
 * 因此每个实例仍然按原顺序进入光栅化与混合，覆盖结果与逐个绘制完全一致。
 */
export function buildPlan(
  sprites: readonly Sprite[],
  camera: Camera,
  eyeW: number,
  eyeH: number,
  options: BuildPlanOptions = {},
): BatchPlan {
  const viewRect = visibleWorldRect(camera, eyeW, eyeH);
  const visible: number[] = [];
  const culled: number[] = [];
  for (let i = 0; i < sprites.length; i++) {
    if (spriteIsOnScreen(sprites[i]!, camera, eyeW, eyeH, viewRect)) visible.push(i);
    else culled.push(i);
  }

  const reordered = options.reorderWithinLayer === true;
  const blendRank = (blend: BlendMode): number => (blend === 'alpha' ? 0 : 1);
  const paintOrder = visible.slice();
  paintOrder.sort((ia, ib) => {
    const a = sprites[ia]!;
    const b = sprites[ib]!;
    if (a.layer !== b.layer) return a.layer - b.layer;
    if (reordered && a.blend !== b.blend) return blendRank(a.blend) - blendRank(b.blend);
    if (a.order !== b.order) return a.order - b.order;
    return a.id - b.id;
  });

  const batchOfSprite = new Int32Array(sprites.length).fill(-1);
  const rankOfSprite = new Int32Array(sprites.length).fill(-1);
  const batches: Batch[] = [];
  const layerSpans: LayerSpan[] = [];
  const spritesByBlend: Record<BlendMode, number> = { alpha: 0, additive: 0 };
  const batchesByBlend: Record<BlendMode, number> = { alpha: 0, additive: 0 };

  for (let rank = 0; rank < paintOrder.length; rank++) {
    const si = paintOrder[rank]!;
    rankOfSprite[si] = rank;
    spritesByBlend[sprites[si]!.blend]++;
  }

  for (let rank = 0; rank < paintOrder.length; rank++) {
    const sprite = sprites[paintOrder[rank]!]!;
    const prev = batches.length > 0 ? batches[batches.length - 1]! : null;
    const sameLayer = prev !== null && prev.layer === sprite.layer;
    const sameBlend = prev !== null && prev.blend === sprite.blend;
    if (sameLayer && sameBlend) {
      prev!.count++;
      batchOfSprite[paintOrder[rank]!] = prev!.index;
      continue;
    }
    const cut: CutReason =
      prev === null ? 'scene-start' : sameLayer ? 'blend-switch' : 'layer-switch';
    const batch: Batch = {
      index: batches.length,
      first: rank,
      count: 1,
      layer: sprite.layer,
      blend: sprite.blend,
      cut,
      prevBatch: prev ? prev.index : null,
    };
    batches.push(batch);
    batchOfSprite[paintOrder[rank]!] = batch.index;
    batchesByBlend[sprite.blend]++;

    let span = layerSpans.find((s) => s.layer === sprite.layer);
    if (!span) {
      span = { layer: sprite.layer, first: rank, count: 0, batches: [] };
      layerSpans.push(span);
    }
    // 画家顺序保证同层连续；span.first 只在层第一次出现时设定。
    span.count = rank - span.first + 1;
    span.batches.push(batch.index);
  }
  layerSpans.sort((a, b) => a.layer - b.layer);

  const interruptions: Interruption[] = [];
  const interruptedBatch: boolean[] = new Array(batches.length).fill(false);
  for (const span of reordered ? [] : layerSpans) {
    const lastOfBlend: Record<BlendMode, number | null> = { alpha: null, additive: null };
    let prevBatchIndex: number | null = null;
    for (const bi of span.batches) {
      const batch = batches[bi]!;
      const last = lastOfBlend[batch.blend];
      if (last !== null && last !== prevBatchIndex) {
        const between: number[] = [];
        for (let t = span.batches.indexOf(last) + 1; t < span.batches.indexOf(bi); t++) {
          between.push(span.batches[t]!);
        }
        const labels: string[] = [];
        let viaProbe = false;
        for (const b of between) {
          const b0 = batches[b]!;
          for (let r = b0.first; r < b0.first + b0.count; r++) {
            const sprite = sprites[paintOrder[r]!]!;
            if (sprite.draggable) viaProbe = true;
            if (labels.length < 4) labels.push(sprite.label);
          }
        }
        const interrupters = labels.length >= 4 ? [...labels.slice(0, 3), '…'] : labels;
        interruptions.push({
          before: last,
          after: bi,
          between,
          interrupters,
          viaProbe,
          layer: span.layer,
          blend: batch.blend,
        });
        interruptedBatch[last] = true;
        interruptedBatch[bi] = true;
        for (const b of between) interruptedBatch[b] = true;
      }
      lastOfBlend[batch.blend] = bi;
      prevBatchIndex = bi;
    }
  }

  let blendBreaks = 0;
  let layerBreaks = 0;
  for (const batch of batches) {
    if (batch.cut === 'blend-switch') blendBreaks++;
    else if (batch.cut === 'layer-switch') layerBreaks++;
  }

  return {
    paintOrder,
    visible,
    culled,
    batches,
    batchOfSprite,
    rankOfSprite,
    layerSpans,
    interruptions,
    interruptedBatch,
    counts: {
      total: sprites.length,
      visible: visible.length,
      culled: culled.length,
      batches: batches.length,
      blendBreaks,
      layerBreaks,
      interruptedPairs: interruptions.length,
      probeInterruptedPairs: interruptions.filter((it) => it.viaProbe).length,
      spritesByBlend,
      batchesByBlend,
    },
    viewRect,
    reordered,
  };
}

/** 批次内前几个精灵，用于 UI 摘要。 */
export function batchSpriteLabels(
  plan: BatchPlan,
  sprites: readonly Sprite[],
  batch: Batch,
  limit = 4,
): string[] {
  const labels: string[] = [];
  const end = Math.min(batch.first + batch.count, batch.first + limit);
  for (let rank = batch.first; rank < end; rank++) {
    labels.push(sprites[plan.paintOrder[rank]!]!.label);
  }
  return labels;
}
