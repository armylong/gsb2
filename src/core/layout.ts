/**
 * 屏幕空间标签排布引擎（纯函数，无 DOM / Three.js 依赖）。
 *
 * 设计要点：
 * - 每个锚点有 8 个方向 × 4 圈距离的候选位，优先生成短引线。
 * - 标签按「锁定 > 优先级 > 可见性 > 稳定顺序」依次放置，先到先得；
 *   因此空间不足时，被收起的一定是锁定/高优先级之外的标注。
 * - 已放置的标签会记住自己的 slot（粘滞）。只要它还落在窗口内且不与
 *   其它标签冲突，就继续使用同一个 slot —— 缓慢转动镜头时标签不会左右乱跳。
 * - 粘滞位越界时先尝试把它夹回视口内侧（仍保持同一方向），只有确实放不下
 *   才换位或收起。
 * - 如果外部判定镜头发生了「突然切换」，不要传入 stickySlots，即可得到一份
 *   全新的、针对新视角的排布。
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnchorLayoutInput {
  /** 稳定且唯一。 */
  id: string;
  /** 锚点在屏幕上的位置（像素）。 */
  anchor: Point;
  /** 标签盒尺寸（像素）。 */
  width: number;
  height: number;
  /** 1–5，越大越先保留。 */
  priority: number;
  /** 锁定项永远排在最前面，且优先于任何普通项。 */
  locked: boolean;
  /** 最终的稳定排序兜底（例如数据表中的顺序）。 */
  order?: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface LayoutConfig {
  viewport: Viewport;
  /** 标签与视口边缘的最小距离。 */
  padding?: number;
  /** 锚点与标签之间的最小间隙。 */
  labelGap?: number;
  /** 标签之间的最小间隙。 */
  labelSpacing?: number;
  /** 各圈候选位的额外偏移（在第一圈基础上累加）。 */
  ringOffsets?: readonly number[];
  /** 不能压住的 UI 区域（例如悬浮工具条）。 */
  obstacles?: readonly Rect[];
  /** 上一帧的 slot 选择。为空表示重新排布。 */
  stickySlots?: ReadonlyMap<string, number>;
}

export type StowReason = 'space';

export interface LabelPlacement {
  id: string;
  rect: Rect;
  anchor: Point;
  /** 引线在标签上的落点。 */
  attach: Point;
  /** slot = direction + ring * 8。 */
  slot: number;
  direction: number;
  ring: number;
  leaderLength: number;
  /** 该 slot 是否来自上一帧（便于调试/测试）。 */
  sticky: boolean;
  /** 粘滞位被夹回视口内侧时为 true。 */
  clamped: boolean;
  priority: number;
  locked: boolean;
}

export interface StowedLabel {
  id: string;
  reason: StowReason;
}

export interface LayoutResult {
  placements: Map<string, LabelPlacement>;
  stowed: StowedLabel[];
  /** 把本帧结果作为下一帧的 stickySlots。 */
  slots: Map<string, number>;
}

export const DIRECTIONS = [
  { key: 'E', dx: 1, dy: 0 },
  { key: 'W', dx: -1, dy: 0 },
  { key: 'S', dx: 0, dy: 1 },
  { key: 'N', dx: 0, dy: -1 },
  { key: 'SE', dx: 1, dy: 1 },
  { key: 'NE', dx: 1, dy: -1 },
  { key: 'SW', dx: -1, dy: 1 },
  { key: 'NW', dx: -1, dy: -1 },
] as const;

export const DEFAULT_RING_OFFSETS = [0, 30, 66, 110] as const;

const DIRECTION_COUNT = DIRECTIONS.length;
const DIAGONAL_SCALE = 0.72;

/** 方向偏好：左右最自然，斜向次之，正上/正下再次。 */
const DIRECTION_PENALTY = [0, 0, 10, 10, 4, 4, 4, 4];

const EPS = 1e-6;

export function slotFor(direction: number, ring: number): number {
  return ring * DIRECTION_COUNT + direction;
}

export function parseSlot(slot: number): { direction: number; ring: number } {
  return {
    direction: slot % DIRECTION_COUNT,
    ring: Math.floor(slot / DIRECTION_COUNT),
  };
}

/** 计算某个 slot 下的标签矩形。 */
export function candidateRect(
  anchor: Point,
  width: number,
  height: number,
  direction: number,
  gap: number,
): Rect {
  const dir = DIRECTIONS[direction];
  const dx = dir.dx * (dir.dx !== 0 && dir.dy !== 0 ? DIAGONAL_SCALE : 1);
  const dy = dir.dy * (dir.dx !== 0 && dir.dy !== 0 ? DIAGONAL_SCALE : 1);

  let x: number;
  if (dir.dx > 0) x = anchor.x + gap * dx;
  else if (dir.dx < 0) x = anchor.x + gap * dx - width;
  else x = anchor.x - width / 2;

  let y: number;
  if (dir.dy > 0) y = anchor.y + gap * dy;
  else if (dir.dy < 0) y = anchor.y + gap * dy - height;
  else y = anchor.y - height / 2;

  return { x, y, w: width, h: height };
}

/** 标签矩形上离锚点最近的点，用作引线终点。 */
export function attachPoint(rect: Rect, direction: number): Point {
  const dir = DIRECTIONS[direction];
  let x: number;
  if (dir.dx > 0) x = rect.x;
  else if (dir.dx < 0) x = rect.x + rect.w;
  else x = rect.x + rect.w / 2;

  let y: number;
  if (dir.dy > 0) y = rect.y;
  else if (dir.dy < 0) y = rect.y + rect.h;
  else y = rect.y + rect.h / 2;

  return { x, y };
}

export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return (
    a.x < b.x + b.w + gap - EPS &&
    a.x + a.w + gap - EPS > b.x &&
    a.y < b.y + b.h + gap - EPS &&
    a.y + a.h + gap - EPS > b.y
  );
}

function rectInside(rect: Rect, viewport: Viewport, padding: number): boolean {
  return (
    rect.x >= padding - EPS &&
    rect.y >= padding - EPS &&
    rect.x + rect.w <= viewport.width - padding + EPS &&
    rect.y + rect.h <= viewport.height - padding + EPS
  );
}

function clampRect(rect: Rect, viewport: Viewport, padding: number): Rect {
  const maxX = Math.max(padding, viewport.width - padding - rect.w);
  const maxY = Math.max(padding, viewport.height - padding - rect.h);
  return {
    ...rect,
    x: Math.min(Math.max(rect.x, padding), maxX),
    y: Math.min(Math.max(rect.y, padding), maxY),
  };
}

function leaderLength(anchor: Point, attach: Point): number {
  return Math.hypot(attach.x - anchor.x, attach.y - anchor.y);
}

function priorityScore(a: AnchorLayoutInput): number {
  // 遮挡只影响样式，不参与排序：否则同一优先级的两项会因为遮挡状态变化
  // 而互换次序，粘滞位失效、标签来回跳。
  return (a.locked ? 1000 : 0) + a.priority * 10;
}

export function sortForLayout(anchors: readonly AnchorLayoutInput[]): AnchorLayoutInput[] {
  return anchors
    .map((a, index) => ({ a, index }))
    .sort((l, r) => {
      const ps = priorityScore(r.a) - priorityScore(l.a);
      if (ps !== 0) return ps;
      const lo = l.a.order ?? l.index;
      const ro = r.a.order ?? r.index;
      if (lo !== ro) return lo - ro;
      return l.a.id < r.a.id ? -1 : l.a.id > r.a.id ? 1 : 0;
    })
    .map((entry) => entry.a);
}

function collides(
  rect: Rect,
  placed: readonly Rect[],
  obstacles: readonly Rect[],
  spacing: number,
): boolean {
  for (const other of placed) {
    if (rectsOverlap(rect, other, spacing)) return true;
  }
  for (const obstacle of obstacles) {
    if (rectsOverlap(rect, obstacle, spacing * 0.5)) return true;
  }
  return false;
}

export function layoutLabels(
  anchors: readonly AnchorLayoutInput[],
  config: LayoutConfig,
): LayoutResult {
  const viewport = config.viewport;
  const padding = config.padding ?? 10;
  const labelGap = config.labelGap ?? 16;
  const spacing = config.labelSpacing ?? 6;
  const rings = config.ringOffsets ?? DEFAULT_RING_OFFSETS;
  const obstacles = config.obstacles ?? [];
  const stickySlots = config.stickySlots;

  const placements = new Map<string, LabelPlacement>();
  const stowed: StowedLabel[] = [];
  const placedRects: Rect[] = [];
  const slots = new Map<string, number>();

  const ordered = sortForLayout(anchors);

  for (const item of ordered) {
    const canFitOnScreen =
      item.width <= viewport.width - padding * 2 + EPS &&
      item.height <= viewport.height - padding * 2 + EPS;
    if (!canFitOnScreen) {
      stowed.push({ id: item.id, reason: 'space' });
      continue;
    }

    let chosen: LabelPlacement | null = null;
    const sticky = stickySlots?.get(item.id);
    const stickyDir = sticky !== undefined ? sticky % DIRECTION_COUNT : null;
    const stickyRing = sticky !== undefined ? Math.floor(sticky / DIRECTION_COUNT) : null;
    const stickyDx = stickyDir !== null ? DIRECTIONS[stickyDir].dx : 0;

    if (sticky !== undefined && rings.length > 0) {
      const { direction, ring } = parseSlot(sticky);
      if (ring >= 0 && ring < rings.length) {
        const gap = labelGap + rings[ring];
        const raw = candidateRect(item.anchor, item.width, item.height, direction, gap);
        const inside = rectInside(raw, viewport, padding);
        const clamped = inside ? raw : clampRect(raw, viewport, padding);
        const wasClamped = !inside || clamped.x !== raw.x || clamped.y !== raw.y;
        if (!collides(clamped, placedRects, obstacles, spacing)) {
          const attach = attachPoint(clamped, direction);
          chosen = {
            id: item.id,
            rect: clamped,
            anchor: item.anchor,
            attach,
            slot: sticky,
            direction,
            ring,
            leaderLength: leaderLength(item.anchor, attach),
            sticky: true,
            clamped: wasClamped,
            priority: item.priority,
            locked: item.locked,
          };
        }
      }
    }

    if (!chosen) {
      let bestScore = Number.POSITIVE_INFINITY;
      let best: LabelPlacement | null = null;
      let bestStickyDirScore = Number.POSITIVE_INFINITY;
      let bestStickyDir: LabelPlacement | null = null;

      for (let ring = 0; ring < rings.length; ring += 1) {
        const gap = labelGap + rings[ring];
        for (let direction = 0; direction < DIRECTION_COUNT; direction += 1) {
          const rect = candidateRect(item.anchor, item.width, item.height, direction, gap);
          if (!rectInside(rect, viewport, padding)) continue;
          if (collides(rect, placedRects, obstacles, spacing)) continue;

          const attach = attachPoint(rect, direction);
          const sameRingBonus = ring === stickyRing ? 6 : 0;
          // 同侧（左/右）优先于换边，避免缓慢旋转时标签左右互换。
          const sameSideBonus =
            stickyDx !== 0 && DIRECTIONS[direction].dx === stickyDx ? 26 : 0;
          const score =
            leaderLength(item.anchor, attach) +
            DIRECTION_PENALTY[direction] +
            ring * 2 -
            sameRingBonus -
            sameSideBonus;
          const slot = slotFor(direction, ring);
          const placement: LabelPlacement = {
            id: item.id,
            rect,
            anchor: item.anchor,
            attach,
            slot,
            direction,
            ring,
            leaderLength: leaderLength(item.anchor, attach),
            sticky: false,
            clamped: false,
            priority: item.priority,
            locked: item.locked,
          };
          if (
            score < bestScore - EPS ||
            (Math.abs(score - bestScore) <= EPS && best && slot < best.slot)
          ) {
            bestScore = score;
            best = placement;
          }
          // 粘滞方向优先：只要同一侧还有位置，就不换到锚点另一侧，
          // 这样缓慢旋转时标签不会左右互换。
          if (stickyDir !== null && direction === stickyDir && score < bestStickyDirScore - EPS) {
            bestStickyDirScore = score;
            bestStickyDir = placement;
          }
        }
      }

      chosen = bestStickyDir ?? best;
    }

    if (chosen) {
      placements.set(item.id, chosen);
      placedRects.push(chosen.rect);
      slots.set(item.id, chosen.slot);
    } else {
      stowed.push({ id: item.id, reason: 'space' });
    }
  }

  return { placements, stowed, slots };
}
