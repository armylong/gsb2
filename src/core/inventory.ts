import type { BagDef, Cell, ItemDef, Placement, WorldState } from './types';
import { cellKey, normalize, occupiedCells, sameCell } from './geometry';

/** itemId -> 放置结果 */
export type PlacementMap = Map<string, Placement>;

export function toPlacementMap(placements: Placement[]): PlacementMap {
  const m: PlacementMap = new Map();
  for (const p of placements) m.set(p.itemId, p);
  return m;
}

export function getPlacement(world: WorldState, itemId: string): Placement | undefined {
  return world.placements.find((p) => p.itemId === itemId);
}

export function getBag(world: WorldState, bagId: string): BagDef | undefined {
  return world.bags.find((b) => b.id === bagId);
}

/** 统计已占格数(按背包+格子去重; 合法布局下同背包内不会有重复) */
export function countOccupiedCells(items: ItemDef[], world: WorldState): number {
  const byId = new Map(items.map((i) => [i.id, i]));
  const cells = new Set<string>();
  for (const p of world.placements) {
    const item = byId.get(p.itemId);
    if (!item) continue;
    // 必须带上背包 id: 两个背包的网格坐标各自从 (0,0) 开始, 否则会被错误合并
    for (const c of occupiedCells(item, p)) cells.add(`${p.bagId}:${cellKey(c)}`);
  }
  return cells.size;
}

export type BlockReason =
  | { kind: 'out-of-bounds'; bagId: string; cells: Cell[] }
  | { kind: 'collision'; bagId: string; cells: Cell[]; hitItemIds: string[] };

export interface PlacementCheck {
  ok: boolean;
  reasons: BlockReason[];
}

/**
 * 检查一件物品在指定背包、指定锚点/旋转下能否放下。
 * excludeItemIds 中的物品占位不视为碰撞(拖动/交换时这些格会被腾空)。
 */
export function checkPlacement(
  items: ItemDef[],
  world: WorldState,
  bagId: string,
  item: ItemDef,
  anchor: Cell,
  rotation: Placement['rotation'],
  excludeItemIds: string[] = [],
): PlacementCheck {
  const bag = getBag(world, bagId);
  const reasons: BlockReason[] = [];
  if (!bag) {
    return { ok: false, reasons: [{ kind: 'out-of-bounds', bagId, cells: [] }] };
  }
  const exclude = new Set(excludeItemIds);
  const candidateCells = occupiedCells(item, { itemId: item.id, bagId, anchor, rotation });

  const inBounds: Cell[] = [];
  const oob: Cell[] = [];
  for (const c of candidateCells) {
    if (c.col < 0 || c.row < 0 || c.col >= bag.cols || c.row >= bag.rows) oob.push(c);
    else inBounds.push(c);
  }
  if (oob.length > 0) reasons.push({ kind: 'out-of-bounds', bagId, cells: oob });

  // 该背包内未被排除物品的占格图
  const occupied = new Map<string, string>();
  for (const p of world.placements) {
    if (p.bagId !== bagId || exclude.has(p.itemId)) continue;
    const other = items.find((i) => i.id === p.itemId);
    if (!other) continue;
    for (const c of occupiedCells(other, p)) occupied.set(cellKey(c), p.itemId);
  }
  const hit = new Map<string, Cell[]>();
  for (const c of inBounds) {
    const owner = occupied.get(cellKey(c));
    if (owner) {
      if (!hit.has(owner)) hit.set(owner, []);
      hit.get(owner)!.push(c);
    }
  }
  if (hit.size > 0) {
    reasons.push({
      kind: 'collision',
      bagId,
      cells: [...hit.values()].flat(),
      hitItemIds: [...hit.keys()],
    });
  }
  return { ok: reasons.length === 0, reasons };
}

export type DropKind = 'none' | 'move' | 'swap';

export interface DropPlan {
  kind: DropKind;
  targetCheck: PlacementCheck;
  swapCheck?: PlacementCheck;
  swapWith?: string;
  ok: boolean;
  /** 供 UI 展示的中文原因 */
  message?: string;
}

export interface DropRequest {
  item: ItemDef;
  from: Placement;
  toBagId: string;
  anchor: Cell;
  rotation: Placement['rotation'];
}

/**
 * 评估一次拖动放下:
 * - 落点不与任何物品重叠 => 移动(含同包移动/跨包移动)
 * - 恰好撞到一件物品 => 尝试交换, 两边都合法才整体成功
 * - 撞到多件或任一侧放不下 => 整次失败, 不挤走任何物品
 */
export function planDrop(items: ItemDef[], world: WorldState, req: DropRequest): DropPlan {
  const targetCheck = checkPlacement(
    items,
    world,
    req.toBagId,
    req.item,
    req.anchor,
    req.rotation,
    [req.item.id],
  );

  if (targetCheck.ok) {
    const noOp =
      req.from.bagId === req.toBagId &&
      req.from.rotation === req.rotation &&
      sameCell(req.from.anchor, req.anchor);
    return { kind: noOp ? 'none' : 'move', targetCheck, ok: true };
  }

  const hasOob = targetCheck.reasons.some((r) => r.kind === 'out-of-bounds');
  const collision = targetCheck.reasons.find((r) => r.kind === 'collision');
  if (hasOob) {
    const n = targetCheck.reasons
      .filter((r) => r.kind === 'out-of-bounds')
      .reduce((sum, r) => sum + r.cells.length, 0);
    return {
      kind: 'none',
      targetCheck,
      ok: false,
      message: `落点越界: ${req.item.name} 有 ${n} 格落在背包外`,
    };
  }
  if (!collision) {
    return { kind: 'none', targetCheck, ok: false, message: '落点非法' };
  }
  if (collision.hitItemIds.length !== 1) {
    return {
      kind: 'none',
      targetCheck,
      ok: false,
      message: `碰到 ${collision.hitItemIds.length} 件物品, 交换只允许恰好碰到一件, 本次失败`,
    };
  }

  const swapWithId = collision.hitItemIds[0];
  const swapItem = items.find((i) => i.id === swapWithId)!;
  // 交换时双方原格都会腾空, 因此同时排除两件物品
  const swapCheck = checkPlacement(
    items,
    world,
    req.from.bagId,
    swapItem,
    req.from.anchor,
    req.from.rotation,
    [swapWithId, req.item.id],
  );
  return {
    kind: 'swap',
    targetCheck,
    swapCheck,
    swapWith: swapWithId,
    ok: swapCheck.ok,
    message: swapCheck.ok
      ? undefined
      : `交换失败: ${swapItem.name} 无法以原朝向放回锚点 ${req.from.anchor.col},${req.from.anchor.row}, 整次回滚`,
  };
}

/**
 * 按评估通过的方案生成新世界状态。
 * 只在 planDrop.ok 时调用; 未通过或 no-op 时返回原状态。
 */
export function executeDrop(world: WorldState, req: DropRequest, plan: DropPlan): WorldState {
  if (!plan.ok || plan.kind === 'none') return world;
  const nextPlacements = world.placements.map((p) => ({ ...p }));
  const dragIdx = nextPlacements.findIndex((p) => p.itemId === req.item.id);
  if (dragIdx < 0) return world;

  if (plan.kind === 'move') {
    nextPlacements[dragIdx] = {
      itemId: req.item.id,
      bagId: req.toBagId,
      anchor: { ...req.anchor },
      rotation: req.rotation,
    };
    return { ...world, placements: nextPlacements };
  }

  // swap: 两边一起生效, 任一侧不合法都不会走到这里
  const swapIdx = nextPlacements.findIndex((p) => p.itemId === plan.swapWith);
  if (swapIdx < 0) return world;
  const swappedOld = { ...nextPlacements[swapIdx] };
  nextPlacements[dragIdx] = {
    itemId: req.item.id,
    bagId: req.toBagId,
    anchor: { ...req.anchor },
    rotation: req.rotation,
  };
  // 被换物品: 保持原朝向, 放入拖动物品原来的背包与锚点
  nextPlacements[swapIdx] = {
    itemId: swappedOld.itemId,
    bagId: req.from.bagId,
    anchor: { ...req.from.anchor },
    rotation: swappedOld.rotation,
  };
  return { ...world, placements: nextPlacements };
}

export interface LayoutIssue {
  message: string;
}

/**
 * 布局全量校验(载入本地文件时使用):
 * 编号重复、形状非法、背包缺失、越界、重叠、物品缺失/多重放置都会拒绝。
 */
export function validateLayout(items: ItemDef[], world: WorldState): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const bagIds = new Set(world.bags.map((b) => b.id));

  // 物品定义: 编号唯一、形状非空且归一化
  const itemIds = new Set<string>();
  for (const item of items) {
    if (itemIds.has(item.id)) issues.push({ message: `物品编号重复: ${item.id}` });
    itemIds.add(item.id);
    if (item.shape.length === 0) issues.push({ message: `物品 ${item.id} 形状为空` });
    if (JSON.stringify(item.shape) !== JSON.stringify(normalize(item.shape))) {
      issues.push({ message: `物品 ${item.id} 占格形状未归一化或含重复格` });
    }
  }

  // 每件物品恰好放置一次
  const placed = new Map<string, number>();
  for (const p of world.placements) placed.set(p.itemId, (placed.get(p.itemId) ?? 0) + 1);
  for (const id of itemIds) {
    const n = placed.get(id) ?? 0;
    if (n === 0) issues.push({ message: `物品 ${id} 缺少放置结果` });
    if (n > 1) issues.push({ message: `物品 ${id} 存在 ${n} 条放置结果` });
  }
  for (const id of placed.keys()) {
    if (!itemIds.has(id)) issues.push({ message: `放置结果引用了未知物品: ${id}` });
  }

  // 逐件: 背包存在、旋转合法、越界
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const p of world.placements) {
    const item = byId.get(p.itemId);
    if (!item) continue;
    if (!bagIds.has(p.bagId)) {
      issues.push({ message: `物品 ${p.itemId} 放在了不存在的背包 ${p.bagId}` });
      continue;
    }
    if (![0, 1, 2, 3].includes(p.rotation)) {
      issues.push({ message: `物品 ${p.itemId} 旋转值非法: ${p.rotation}` });
    }
    const check = checkPlacement(
      items,
      { ...world, placements: [] },
      p.bagId,
      item,
      p.anchor,
      p.rotation,
    );
    const oob = check.reasons.find((r) => r.kind === 'out-of-bounds');
    if (oob) issues.push({ message: `物品 ${p.itemId} 越界 ${oob.cells.length} 格` });
  }

  // 重叠: 同一背包内占格冲突
  for (const bag of world.bags) {
    const owner = new Map<string, string>();
    for (const p of world.placements) {
      if (p.bagId !== bag.id) continue;
      const item = byId.get(p.itemId);
      if (!item) continue;
      for (const c of occupiedCells(item, p)) {
        const k = cellKey(c);
        const prev = owner.get(k);
        if (prev) {
          issues.push({ message: `背包 ${bag.id} 中 ${prev} 与 ${p.itemId} 在 ${k} 重叠` });
        } else {
          owner.set(k, p.itemId);
        }
      }
    }
  }
  return issues;
}
