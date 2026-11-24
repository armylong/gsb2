// 推断链验证：把玩家圈出的线索顺序与每条路线的规则比对。
//
// 关键设计：
//  - 不向玩家展示完整路线，只给出「支持 / 线索不够 / 矛盾」三类结论；
//  - 浅痕（方向、深浅不可读）永远不会构成矛盾，只是提供不了信息；
//  - 跳格要求路线上存在一条长度恰好为 2 的直线段把前后两格接起来；
//  - 「矛盾」必须来自确实读到的属性（方向、深浅）与某条路线冲突，
//    或跳格在该路线上接不上；
//  - 两条路线都还兼容 → 线索不够；恰好一条兼容且含足够方向线索 → 支持。

import type { GameState } from './game.js';
import {
  ChainEntry,
  DepthLevel,
  Dir,
  DIR_VECTORS,
  Observation,
  RouteDef,
  Visibility,
  VisibleImpression,
} from './types.js';

export interface RouteCheck {
  routeId: number;
  compatible: boolean;
  /** 第一个导致矛盾的线索序号（从 0 起，含跳格）；兼容时为 null */
  conflictIndex: number | null;
  conflictReason: string | null;
  /** 该路线上匹配到的步序号序列（用于内部自检/调试，不展示完整路线） */
  matchedSteps: number[];
  directionalClues: number;
}

export interface VerifyResult {
  verdict: 'supported' | 'insufficient' | 'contradiction';
  /** supported 时给出唯一兼容路线的 id */
  supportedRouteId: number | null;
  checks: RouteCheck[];
  /** 可读的结论说明，不包含完整路线 */
  message: string;
}

/** 至少需要这么多条带方向的可读线索，才能把一条路线和另一条区分开 */
const MIN_DIRECTIONAL_CLUES = 2;

function routeIndexMap(route: RouteDef): Map<string, number> {
  const m = new Map<string, number>();
  route.cells.forEach(([x, y], i) => m.set(`${x},${y}`, i));
  return m;
}

/**
 * 深浅与路线重量是否相容：
 * 深浅是离散观察档，存在抖动且雪面状态会让读数在相邻档之间浮动，
 * 所以只保留一条强单向约束——轻量路线压不出深脚印；
 * 中/重量路线读到深、中、浅都可能（新脚印偏深、磨损后偏浅）。
 * 浅痕（Trace）不带深浅信息，直接通过。
 */
function depthCompatible(imp: VisibleImpression, route: RouteDef): boolean {
  if (imp.visibility !== Visibility.Visible) return true;
  if (route.weight === 0 && imp.depth === DepthLevel.Deep) return false;
  return true;
}

/** 在路线上找从步序 fromStep 出发、经一步跳格（直线两格）到达 (tx,ty) 的落点步序 */
function gapLanding(
  route: RouteDef,
  fromStep: number,
  tx: number,
  ty: number,
): number | null {
  const [fx, fy] = route.cells[fromStep];
  for (const [vx, vy] of DIR_VECTORS) {
    const lx = fx + 2 * vx;
    const ly = fy + 2 * vy;
    if (lx === tx && ly === ty) {
      const idx = routeIndexMap(route).get(`${lx},${ly}`);
      if (idx !== undefined && idx === fromStep + 2) return idx;
    }
  }
  return null;
}

export function verifyChain(game: GameState): VerifyResult {
  const chain = game.chain;
  const checks: RouteCheck[] = game.scenario.routes.map((route) =>
    checkRoute(route, chain, game),
  );

  const compatible = checks.filter((c) => c.compatible);
  const totalDirectional = checks.reduce(
    (acc, c) => Math.max(acc, c.directionalClues),
    0,
  );

  if (chain.length === 0) {
    return {
      verdict: 'insufficient',
      supportedRouteId: null,
      checks,
      message: '推断链是空的：先在标记模式下圈出至少两格带方向的脚印。',
    };
  }

  if (compatible.length === 0) {
    const detail = checks
      .map((c) => `路线 ${c.routeId}：${c.conflictReason ?? '无法按此顺序经过'}`)
      .join('；');
    return {
      verdict: 'contradiction',
      supportedRouteId: null,
      checks,
      message: `线索确实相互矛盾，两条路线都接不上——${detail}。`,
    };
  }

  if (compatible.length >= 2) {
    const reason =
      totalDirectional < MIN_DIRECTIONAL_CLUES
        ? `线索不够：带方向的可读脚印只有 ${totalDirectional} 条，至少需要 ${MIN_DIRECTIONAL_CLUES} 条才能区分两条路线。`
        : '线索不够：两条路线都能容纳当前这串线索，去叠踩路口或避风区再找一个方向/深浅不同的脚印。';
    return {
      verdict: 'insufficient',
      supportedRouteId: null,
      checks,
      message: reason,
    };
  }

  const only = compatible[0];
  if (only.directionalClues < MIN_DIRECTIONAL_CLUES) {
    return {
      verdict: 'insufficient',
      supportedRouteId: null,
      checks,
      message: `线索不够：虽然只有一条路线能走通，但带方向的脚印只有 ${only.directionalClues} 条，再确认一个方向后下结论更稳妥。`,
    };
  }

  return {
    verdict: 'supported',
    supportedRouteId: only.routeId,
    checks,
    message: `线索自洽：这串足迹可以属于同一条轨迹（路线 ${only.routeId}）。注意这只确认了你圈出的部分，完整路线仍需自己走完。`,
  };
}

function checkRoute(
  route: RouteDef,
  chain: ChainEntry[],
  game: GameState,
): RouteCheck {
  const index = routeIndexMap(route);
  const result: RouteCheck = {
    routeId: route.id,
    compatible: true,
    conflictIndex: null,
    conflictReason: null,
    matchedSteps: [],
    directionalClues: 0,
  };

  let expectedStep: number | null = null; // 路线上当前应对上的步序

  const fail = (i: number, reason: string): RouteCheck => {
    result.compatible = false;
    result.conflictIndex = i;
    result.conflictReason = `第 ${i + 1} 条线索矛盾：${reason}`;
    return result;
  };

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];

    if (entry.kind === 'gap') {
      if (expectedStep === null) {
        return fail(i, '跳格前还没有对上任何路线格子。');
      }
      const next = chain[i + 1];
      if (!next || next.kind !== 'obs') {
        return fail(i, '跳格后面必须再接一个观察格。');
      }
      const landing = gapLanding(route, expectedStep, next.x, next.y);
      if (landing === null) {
        return fail(
          i,
          `路线 ${route.id} 在这一带无法用一次直线跳格把前后两个格子接起来。`,
        );
      }
      expectedStep = landing;
      i++; // 跳过下一个 obs 的常规处理，下面手动校验它
      const obs = game.getObservation(next.x, next.y);
      const clue = pickImpression(obs, next.pick);
      if (!clue) return fail(i, '该格没有可见足迹。');
      if (clue.routeId !== route.id) {
        return fail(i, `这格叠着多条脚印，你圈的是路线 ${clue.routeId} 的那条，与路线 ${route.id} 不符。`);
      }
      if (!checkClue(clue, route, expectedStep, result)) {
        return fail(i, describeClueConflict(clue, route));
      }
      result.matchedSteps.push(expectedStep);
      continue;
    }

    // 普通观察格
    const step = index.get(`${entry.x},${entry.y}`);
    if (step === undefined) {
      return fail(i, `路线 ${route.id} 根本不经过 (${entry.x},${entry.y})。`);
    }
    if (expectedStep !== null && step <= expectedStep) {
      return fail(i, '路线在这一格是往回走的，和你圈出的先后顺序不符。');
    }
    if (expectedStep !== null && step - expectedStep !== 1) {
      return fail(
        i,
        `路线上这两格之间还隔着 ${step - expectedStep - 1} 个格子，需要插入跳格（一次只能跳一格）。`,
      );
    }
    const obs = game.getObservation(entry.x, entry.y);
    const clue = pickImpression(obs, entry.pick);
    if (!clue) return fail(i, '该格没有可见足迹。');
    if (clue.routeId !== route.id) {
      return fail(i, `这格叠着多条脚印，你圈的是路线 ${clue.routeId} 的那条，与路线 ${route.id} 不符。`);
    }
    if (!checkClue(clue, route, step, result)) {
      return fail(i, describeClueConflict(clue, route));
    }
    expectedStep = step;
    result.matchedSteps.push(step);
  }

  return result;
}

/** 取观察记录中玩家圈定的那条足迹（下标按从新到旧的可见栈） */
function pickImpression(
  obs: Observation | undefined,
  pick: number,
): VisibleImpression | null {
  if (!obs || obs.impressions.length === 0) return null;
  return obs.impressions[Math.min(pick, obs.impressions.length - 1)] ?? null;
}

/** 校验单条可见足迹与路线在该格的属性是否冲突；顺带统计方向线索数 */
function checkClue(
  clue: VisibleImpression,
  route: RouteDef,
  step: number,
  result: RouteCheck,
): boolean {
  if (clue.visibility === Visibility.Visible) {
    result.directionalClues++;
    // 方向必须与路线在该格的走向一致
    const expectedDir = routeDirAt(route, step);
    if (expectedDir !== null && clue.dir !== null && clue.dir !== expectedDir) {
      return false;
    }
  }
  return depthCompatible(clue, route);
}

function routeDirAt(route: RouteDef, step: number): Dir | null {
  const a = route.cells[step];
  const b = route.cells[step + 1];
  if (!b) {
    // 末端格：足迹方向沿用最后一段的前进方向（a - prev），
    // 与 scenarios.buildImpressions 的末端定义保持一致
    const prev = route.cells[step - 1];
    if (!prev) return null;
    return vectorToDir(a[0] - prev[0], a[1] - prev[1]);
  }
  return vectorToDir(b[0] - a[0], b[1] - a[1]);
}

function vectorToDir(dx: number, dy: number): Dir | null {
  for (let d = 0 as Dir; d < 4; d++) {
    const [vx, vy] = DIR_VECTORS[d];
    if (vx === dx && vy === dy) return d;
  }
  return null;
}

function describeClueConflict(clue: VisibleImpression, route: RouteDef): string {
  if (clue.visibility === Visibility.Visible && clue.depth === DepthLevel.Deep && route.weight === 0) {
    return `读到的是深脚印，但路线 ${route.id} 的落脚重量偏轻，压不出这么深的痕。`;
  }
  return `读到的方向与路线 ${route.id} 在该格的走向不一致。`;
}
