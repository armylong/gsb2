/**
 * 干涉检测
 *
 * 判据(轻量、确定性、适合编辑器实时反馈):
 * 1. 沿总进度轴密集采样, 每点更新世界矩阵后取零件世界 AABB,
 *    先用三轴 AABB 相交做粗筛, 避免贴合面(EPS 容差)误报
 * 2. 合法重叠豁免:
 *    - 配置显式声明的滑动配合/共拆紧固件(铰链销轴与耳片、同孔螺钉与垫片)
 *    - 装配树中的祖先-后代零件: 场景图里刚性绑定、一起移动
 *      (盖板与其螺钉、支架与其紧固件)
 * 3. 「被卡住」的物理判据: 运动件沿自己的装配方向移动时, 其沿运动方向的
 *    前缘始终无法越过阻挡件的对应面。正常从开口抽出的零件(如螺钉穿过外壳
 *    顶部开口)在 AABB 粗筛阶段会相交, 但沿运动轴方向其实已经越过外壳壁,
 *    不会被判卡; 被封闭盖板挡住的螺钉前缘一直停在盖板底面之下 -> 判干涉。
 *    问题区间取最后一次进入相交的采样点到动作窗口末端。
 */
import * as THREE from 'three';
import type { CollisionHit, EditorConfig, PartDef } from './types';
import { PHASE_SPAN } from './explosion';
import type { AssemblyScene } from './scene';

export interface CollisionReport {
  hits: CollisionHit[];
  /** 初始装配即接触的零件对, 供实时检测参考 */
  initialContact: [string, string][];
}

const SAMPLES = 61;
/** AABB 重叠量小于该值视为间隙/贴合(单位与场景一致) */
const EPS = 0.04;
/** 进度轴比较容差, 处理浮点窗口边界 */
const EPS_T = 1e-6;
/** 运动方向与坐标轴对齐判定阈值(爆炸方向均按 ±X/±Y/±Z 设计) */
const AXIS_ALIGNED = 0.9;

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

function explicitIgnore(config: EditorConfig): Set<string> {
  const set = new Set<string>();
  for (const ig of config.collisionIgnore) set.add(pairKey(ig.a, ig.b));
  return set;
}

/** 预计算装配树祖先-后代零件对, 它们刚性共动, 不做碰撞检查 */
function ancestorPairs(config: EditorConfig): Set<string> {
  const byId = new Map(config.parts.map((p) => [p.id, p]));
  const result = new Set<string>();
  for (const part of config.parts) {
    let cur: PartDef | undefined = part.parentId ? byId.get(part.parentId) : undefined;
    while (cur) {
      result.add(pairKey(part.id, cur.id));
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return result;
}

/** step 动作窗口换算到全局进度轴; 无 step 返回 null */
function globalWindow(part: PartDef): [number, number] | null {
  if (!part.step) return null;
  const base = part.step.phase * PHASE_SPAN;
  return [base + part.step.start * PHASE_SPAN, base + part.step.end * PHASE_SPAN];
}

type Axis = 0 | 1 | 2;

/** AABB 三轴粗筛: 三个轴的重叠长度都要超过 EPS */
function aabbOverlap(a: THREE.Box3, b: THREE.Box3): boolean {
  const axes: Axis[] = [0, 1, 2];
  return axes.every((ax) => {
    const minA = ax === 0 ? a.min.x : ax === 1 ? a.min.y : a.min.z;
    const maxA = ax === 0 ? a.max.x : ax === 1 ? a.max.y : a.max.z;
    const minB = ax === 0 ? b.min.x : ax === 1 ? b.min.y : b.min.z;
    const maxB = ax === 0 ? b.max.x : ax === 1 ? b.max.y : b.max.z;
    return Math.min(maxA, maxB) - Math.max(minA, minB) > EPS;
  });
}

/**
 * 运动件是否真的被阻挡件卡住: 只看运动轴方向的前缘。
 * - 向上(+)抽出: 运动件顶端必须越过阻挡件顶端面, 否则被盖在下方(封闭盖板压螺钉)
 * - 向下(-)抽出: 运动件底端必须低于阻挡件底端面
 * 从开口容器内部向上抽出时, 虽然横向仍被墙包围(AABB 粗筛相交),
 * 但前缘一旦越过墙顶即视为脱出, 不会误报。
 */
function isBlocked(
  mover: THREE.Box3,
  blockerBox: THREE.Box3,
  axis: Axis,
  sign: 1 | -1,
): boolean {
  const moverMin = axis === 0 ? mover.min.x : axis === 1 ? mover.min.y : mover.min.z;
  const moverMax = axis === 0 ? mover.max.x : axis === 1 ? mover.max.y : mover.max.z;
  const blockMin = axis === 0 ? blockerBox.min.x : axis === 1 ? blockerBox.min.y : blockerBox.min.z;
  const blockMax = axis === 0 ? blockerBox.max.x : axis === 1 ? blockerBox.max.y : blockerBox.max.z;
  if (sign > 0) return moverMax <= blockMax + EPS;
  return moverMin >= blockMin - EPS;
}

interface MoverTracker {
  blocker: string;
  axis: Axis;
  sign: 1 | -1;
  windowStart: number;
  windowEnd: number;
  /** 最后一次「从自由变为卡住」的进度, 作为问题区间起点 */
  lastEnter: number | null;
  prevBlocked: boolean;
  /** 窗口内是否曾经沿运动方向越过阻挡件端面(越过 = 能正常脱出) */
  everCrossed: boolean;
}

/** key = 零件对 + 运动件 id, 因为同一对在两个零件各自的窗口里要分别评估 */
type TrackerKey = string;
const trackerKey = (pair: string, mover: string): TrackerKey => `${pair}#${mover}`;

/**
 * 全轴扫描。采样会临时改写场景进度, 结束后由调用方再应用一次当前进度。
 */
export function computeSweepCollisions(
  config: EditorConfig,
  scene: AssemblyScene,
): CollisionReport {
  const ignore = explicitIgnore(config);
  const kinematic = ancestorPairs(config);
  const byId = new Map(config.parts.map((p) => [p.id, p]));
  const windows = new Map<string, [number, number] | null>();
  for (const p of config.parts) windows.set(p.id, globalWindow(p));

  const trackers = new Map<TrackerKey, MoverTracker>();
  const initialContact: [string, string][] = [];

  /** 取零件的世界空间运动轴与方向(方向定义在直接父节点局部空间) */
  const motionOf = (partId: string): { axis: Axis; sign: 1 | -1 } => {
    const part = byId.get(partId)!;
    const local = new THREE.Vector3(...(part.step?.dir ?? [0, 1, 0])).normalize();
    const world = local.transformDirection(scene.getParentWorldMatrix(partId));
    const ax: Axis =
      Math.abs(world.x) > AXIS_ALIGNED ? 0 : Math.abs(world.y) > AXIS_ALIGNED ? 1 : 2;
    const comp = ax === 0 ? world.x : ax === 1 ? world.y : world.z;
    return { axis: ax, sign: comp >= 0 ? 1 : -1 };
  };

  /** 在指定进度下评估一对零件的两个运动方向 */
  const evaluateAt = (t: number, idA: string, idB: string, boxes: Map<string, THREE.Box3>) => {
    const pair = pairKey(idA, idB);
    if (ignore.has(pair) || kinematic.has(pair)) return;
    const overlap = aabbOverlap(boxes.get(idA)!, boxes.get(idB)!);

    const evaluate = (moverId: string, blockerId: string) => {
      const win = windows.get(moverId)!;
      // 无爆炸动作的零件不作为运动件评估
      if (win === null) return;
      // 窗口起点之前不评估; 窗口结束后仍继续跟踪(零件保持终点位置),
      // 用来判断它最终是否越过了阻挡件
      if (t < win[0] - EPS_T) return;

      const key = trackerKey(pair, moverId);
      let tracker = trackers.get(key);
      if (!tracker) {
        const { axis, sign } = motionOf(moverId);
        tracker = {
          blocker: blockerId,
          axis,
          sign,
          windowStart: win[0],
          windowEnd: win[1],
          lastEnter: null,
          prevBlocked: false,
          everCrossed: false,
        };
        trackers.set(key, tracker);
      }
      const blockedNow =
        overlap && isBlocked(boxes.get(moverId)!, boxes.get(blockerId)!, tracker.axis, tracker.sign);
      // 只要在任一采样点沿运动方向越过过阻挡件端面, 该零件对就不是卡死
      if (!isBlocked(boxes.get(moverId)!, boxes.get(blockerId)!, tracker.axis, tracker.sign)) {
        tracker.everCrossed = true;
      }
      // 只在运动件自己的窗口内记录「卡住区间」
      if (t <= win[1] + EPS_T) {
        if (blockedNow && !tracker.prevBlocked) tracker.lastEnter = t;
        tracker.prevBlocked = blockedNow;
      }
    };
    evaluate(idA, idB);
    evaluate(idB, idA);
  };

  // 收集所有动作窗口的精确起点/终点, 与均匀采样点合并, 保证窗口边界一定被评估到
  const milestones = new Set<number>();
  for (const part of config.parts) {
    const win = windows.get(part.id);
    if (win) {
      milestones.add(win[0]);
      milestones.add(win[1]);
    }
  }
  const sampleTimes = [...new Set([...Array.from({ length: SAMPLES }, (_, s) => s / (SAMPLES - 1)), ...milestones])].sort(
    (a, b) => a - b,
  );

  for (const t of sampleTimes) {
    scene.applyProgress(t, 0);
    const boxes = new Map<string, THREE.Box3>();
    for (const p of config.parts) boxes.set(p.id, scene.worldBoxOf(p.id));
    if (t <= EPS_T) {
      for (let i = 0; i < config.parts.length; i++) {
        for (let j = i + 1; j < config.parts.length; j++) {
          const pair = pairKey(config.parts[i].id, config.parts[j].id);
          if (ignore.has(pair) || kinematic.has(pair)) continue;
          if (aabbOverlap(boxes.get(config.parts[i].id)!, boxes.get(config.parts[j].id)!)) {
            initialContact.push([config.parts[i].id, config.parts[j].id]);
          }
        }
      }
    }
    for (let i = 0; i < config.parts.length; i++) {
      for (let j = i + 1; j < config.parts.length; j++) {
        evaluateAt(t, config.parts[i].id, config.parts[j].id, boxes);
      }
    }
  }

  // 判定卡死: 窗口末端仍 blocked 且全程未越过阻挡面。
  // 另外要求问题区间覆盖运动窗口的显著比例(>=15%): 两个正常移动零件的短暂
  // 路径交汇只占窗口末端一小段, 而被封闭面挡住的零件会在大部分窗口里卡住。
  const MIN_WINDOW_RATIO = 0.15;
  const hits: CollisionHit[] = [...trackers.entries()]
    .filter(([, tr]) => {
      if (tr.everCrossed || tr.lastEnter === null || !tr.prevBlocked) return false;
      const span = Math.max(tr.windowEnd - tr.windowStart, EPS_T);
      return (tr.windowEnd - tr.lastEnter) / span >= MIN_WINDOW_RATIO;
    })
    .map(([key, tr]) => ({
      moving: key.split('#')[1],
      blocker: tr.blocker,
      rangeStart: Math.max(tr.lastEnter!, tr.windowStart),
      rangeEnd: tr.windowEnd,
    }));
  return { hits, initialContact };
}

/**
 * 拖动进度时的实时检测: 对全轴扫描已确认的卡死零件对,
 * 在其问题区间内且当前确实被挡住时给出即时警告;
 * 恢复正确顺序后扫描清空, 提示自动消失。
 */
export function computeLiveCollisions(
  config: EditorConfig,
  scene: AssemblyScene,
  global: number,
): CollisionHit[] {
  // 完全合装状态下一切重叠都是设计包容, 绝不报警
  if (global <= EPS_T) return [];
  scene.applyProgress(global, 0);
  const ignore = explicitIgnore(config);
  const kinematic = ancestorPairs(config);
  const boxes = new Map<string, THREE.Box3>();
  for (const p of config.parts) boxes.set(p.id, scene.worldBoxOf(p.id));

  const hits: CollisionHit[] = [];
  for (const reportHit of scene.report.hits) {
    const key = pairKey(reportHit.moving, reportHit.blocker);
    if (ignore.has(key) || kinematic.has(key)) continue;
    if (global < reportHit.rangeStart || global > reportHit.rangeEnd) continue;
    const mover = byIdOf(config, reportHit.moving);
    const local = new THREE.Vector3(...(mover.step?.dir ?? [0, 1, 0])).normalize();
    const world = local.transformDirection(scene.getParentWorldMatrix(reportHit.moving));
    const axis: Axis = Math.abs(world.x) > AXIS_ALIGNED ? 0 : Math.abs(world.y) > AXIS_ALIGNED ? 1 : 2;
    const comp = axis === 0 ? world.x : axis === 1 ? world.y : world.z;
    const sign: 1 | -1 = comp >= 0 ? 1 : -1;
    const blocked =
      aabbOverlap(boxes.get(reportHit.moving)!, boxes.get(reportHit.blocker)!) &&
      isBlocked(boxes.get(reportHit.moving)!, boxes.get(reportHit.blocker)!, axis, sign);
    if (blocked) hits.push({ ...reportHit, rangeStart: global, rangeEnd: global });
  }
  return hits;
}

function byIdOf(config: EditorConfig, id: string): PartDef {
  const part = config.parts.find((p) => p.id === id);
  if (!part) throw new Error(`未知零件 ${id}`);
  return part;
}

/** 供面板与时间轴使用: 把命中区间格式化成展示数据 */
export function summarizeHit(hit: CollisionHit, nameOf: (id: string) => string) {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return {
    key: pairKey(hit.moving, hit.blocker),
    text: `${nameOf(hit.moving)} ✕ ${nameOf(hit.blocker)}`,
    rangeText: `进度 ${pct(hit.rangeStart)} – ${pct(hit.rangeEnd)}`,
  };
}
