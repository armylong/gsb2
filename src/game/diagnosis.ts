import {
  adjacencyOfColor,
  allColors,
  detectCrossings,
  diagnoseCrossing,
  holeSet,
  traceRibbon,
} from './board';
import { pathEdgeKeys, sameVertex, vKey } from './geometry';
import type {
  CellDiagnosis,
  ConflictSegment,
  Diagnosis,
  GameState,
  Puzzle,
  TargetCheck,
  Vertex,
} from './types';

function shortestPath(
  adj: Map<string, Vertex[]>,
  from: Vertex,
  to: Vertex,
): Vertex[] | null {
  const startKey = vKey(from);
  if (!adj.has(startKey)) return null;
  const prev = new Map<string, string | null>();
  prev.set(startKey, null);
  const queue: Vertex[] = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (sameVertex(cur, to)) {
      const path: Vertex[] = [];
      let k: string | null = vKey(cur);
      while (k) {
        const [x, y] = k.split(',').map(Number);
        path.unshift({ x, y });
        k = prev.get(k) ?? null;
      }
      return path;
    }
    for (const n of adj.get(vKey(cur)) ?? []) {
      const k = vKey(n);
      if (!prev.has(k)) {
        prev.set(k, vKey(cur));
        queue.push(n);
      }
    }
  }
  return null;
}

/**
 * 检查同一条带相邻交叉点是否「上下相间」：
 * 相邻两个交叉点上，同一条带必须一次压顶、一次穿下交替。
 * 同一段几何冲突会被两条带各看到一次，这里按格点对去重，
 * 只保留「在两点都处于顶层」的颜色作为责任方（它才是破坏交替的一侧）。
 * 返回每一对违反规则的相邻交叉点，以及它们之间真正冲突的那段走法。
 */
export function findAlternationConflicts(
  puzzle: Puzzle,
  state: GameState,
): ConflictSegment[] {
  const conflicts: ConflictSegment[] = [];
  const seenPairs = new Set<string>();
  const crossingInfos = detectCrossings(state);
  const validByKey = new Map(
    crossingInfos.map((c) => [vKey(c.vertex), c]),
  );

  for (const color of allColors(puzzle)) {
    const trace = traceRibbon(puzzle, state, color);
    const seq = trace.crossings.filter((v) => validByKey.get(vKey(v))?.valid);
    const adj = adjacencyOfColor(state, color);
    for (let i = 0; i < seq.length - 1; i++) {
      const a = seq[i];
      const b = seq[i + 1];
      const infoA = validByKey.get(vKey(a))!;
      const infoB = validByKey.get(vKey(b))!;
      const topA = topOf(puzzle, state, infoA);
      const topB = topOf(puzzle, state, infoB);
      const aOnTop = topA === color;
      const bOnTop = topB === color;
      if (aOnTop !== bOnTop) continue; // 一顶一底 = 正确交替
      // 几何段去重键（无序格点对）
      const pairKey = [vKey(a), vKey(b)].sort().join('~');
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      // 责任方：两点都压顶的颜色；若该颜色两点都在底下，责任方是另一种颜色
      const responsible = aOnTop ? color : (topA ?? color);
      const path = shortestPath(adj, a, b) ?? [a, b];
      conflicts.push({ color: responsible, from: a, to: b, path });
    }
  }
  return conflicts;
}

function topOf(
  puzzle: Puzzle,
  state: GameState,
  info: { vertex: Vertex; colors: string[] },
): string | null {
  // 复用 board.resolveTop 的裁定逻辑
  const key = vKey(info.vertex);
  const manual = state.tops[key];
  if (manual && info.colors.includes(manual)) return manual;
  const order = (c: string): number =>
    puzzle.ports.findIndex((p) => p.color === c);
  return [...info.colors].sort((a, b) => order(a) - order(b))[0] ?? null;
}

/** 检查全部目标点；未织完时也照常逐项给出结果。 */
export function checkTargets(
  puzzle: Puzzle,
  state: GameState,
): TargetCheck[] {
  const crossingMap = new Map(
    detectCrossings(state).map((c) => [vKey(c.vertex), c]),
  );
  return puzzle.targets.map((t) => {
    const info = crossingMap.get(vKey(t.vertex));
    if (!info || !info.valid) {
      return {
        vertex: t.vertex,
        expected: t.color,
        actual: info ? topOf(puzzle, state, info) : null,
        state: 'pending' as const,
      };
    }
    const actual = topOf(puzzle, state, info);
    return {
      vertex: t.vertex,
      expected: t.color,
      actual,
      state: actual === t.color ? ('ok' as const) : ('mismatch' as const),
    };
  });
}

/** 整局诊断：结构、交叉、相间冲突、目标一次算清。 */
export function diagnose(puzzle: Puzzle, state: GameState): Diagnosis {
  const crossingInfos = detectCrossings(state);
  const crossings = crossingInfos.map((info) =>
    diagnoseCrossing(puzzle, state, info),
  );
  const invalidCrossings = crossingInfos
    .filter((c) => !c.valid)
    .map((c) => c.vertex);

  const conflicts = findAlternationConflicts(puzzle, state);
  const conflictVertices = new Set<string>();
  const conflictEdges = new Set<string>();
  for (const seg of conflicts) {
    conflictVertices.add(vKey(seg.from));
    conflictVertices.add(vKey(seg.to));
    for (const k of pathEdgeKeys(seg.path)) conflictEdges.add(k);
  }
  for (const c of crossings) {
    c.inConflict = conflictVertices.has(vKey(c.vertex));
  }

  const targets = checkTargets(puzzle, state);
  const ribbons = allColors(puzzle).map((color) =>
    traceRibbon(puzzle, state, color),
  );

  const problems: string[] = [];
  for (const r of ribbons) {
    if (r.complete) continue;
    if (r.openPorts.length) {
      problems.push(`${r.color} 带：${r.openPorts.map(vKey).join('、')} 还空着`);
    }
    if (r.deadEnds.length) {
      problems.push(
        `${r.color} 带在 ${r.deadEnds.map(vKey).join('、')} 断头（没有接到出口）`,
      );
    }
    if (r.branches.length) {
      problems.push(`${r.color} 带在 ${r.branches.map(vKey).join('、')} 出现分叉`);
    }
    if (r.fragments.length > 1) {
      problems.push(`${r.color} 带断成了 ${r.fragments.length} 段，互不相连`);
    }
  }
  for (const v of invalidCrossings) {
    problems.push(`${vKey(v)} 不是对边穿过，两条带无法表达上下关系`);
  }
  for (const seg of conflicts) {
    problems.push(
      `${seg.color} 带：${vKey(seg.from)} 与 ${vKey(seg.to)} 上下没有交替（冲突段已标红）`,
    );
  }
  for (const t of targets) {
    if (t.state === 'mismatch') {
      problems.push(
        `目标 ${vKey(t.vertex)} 要求 ${t.expected} 在顶层，当前是 ${t.actual ?? '空'}`,
      );
    } else if (t.state === 'pending') {
      problems.push(`目标 ${vKey(t.vertex)} 还没织出有效交叉`);
    }
  }

  const solved =
    ribbons.every((r) => r.complete) &&
    invalidCrossings.length === 0 &&
    conflicts.length === 0 &&
    targets.every((t) => t.state === 'ok');

  return {
    ribbons,
    invalidCrossings,
    crossings,
    conflicts,
    conflictEdges: [...conflictEdges],
    targets,
    solved,
    problems,
  };
}

/** 点击单个格点时的判断说明。 */
export function diagnoseCell(
  puzzle: Puzzle,
  state: GameState,
  vertex: Vertex,
): CellDiagnosis {
  const key = vKey(vertex);
  const holes = holeSet(puzzle);
  const port = puzzle.ports.find((p) => sameVertex(p.vertex, vertex));
  const crossing = detectCrossings(state).find((c) =>
    sameVertex(c.vertex, vertex),
  );
  const target =
    puzzle.targets.find((t) => sameVertex(t.vertex, vertex))?.color ?? null;
  const full = diagnose(puzzle, state);
  const conflict = full.conflicts.some(
    (seg) => vKey(seg.from) === key || vKey(seg.to) === key,
  );

  if (holes.has(key)) {
    return {
      vertex,
      status: 'hole',
      colors: [],
      top: null,
      target,
      targetMet: target === null,
      conflict: false,
      message: '禁用孔：任何彩带都不能经过这里',
    };
  }
  if (crossing) {
    const d = full.crossings.find((c) => vKey(c.vertex) === key)!;
    if (!crossing.valid) {
      return {
        vertex,
        status: 'invalid-crossing',
        colors: crossing.colors,
        top: d.top,
        target,
        targetMet: false,
        conflict,
        message: `结构错误：${crossing.colors.join('、')} 没有对边穿过，点击交叉点可改上下关系前需先修结构`,
      };
    }
    const targetText =
      target === null
        ? '此处无花纹要求'
        : d.top === target
          ? `花纹满足：${target} 在顶层`
          : `花纹不符：要求 ${target} 顶层，当前 ${d.top} 顶层`;
    return {
      vertex,
      status: 'crossing',
      colors: crossing.colors,
      top: d.top,
      target,
      targetMet: d.targetMet,
      conflict,
      message: `交叉点：${d.top} 压在 ${d.bottom} 上面；${targetText}${conflict ? '；属于上下相间冲突段' : ''}（点击可翻转上下）`,
    };
  }
  const colorsHere = new Set<string>();
  for (const [ek, color] of Object.entries(state.edges)) {
    const [a, b] = ek.split('|');
    if (a === key || b === key) colorsHere.add(color);
  }
  if (port) {
    return {
      vertex,
      status: 'port',
      colors: [port.color],
      top: null,
      target,
      targetMet: target === null,
      conflict: false,
      message: `${port.kind === 'entry' ? '入口' : '出口'}（${port.label}）：只接受 ${port.color} 带`,
    };
  }
  if (colorsHere.size > 0) {
    return {
      vertex,
      status: 'ribbon',
      colors: [...colorsHere],
      top: null,
      target,
      targetMet: target === null,
      conflict,
      message: `${[...colorsHere].join('、')} 带经过此处${conflict ? '；该段存在上下相间冲突' : ''}`,
    };
  }
  return {
    vertex,
    status: 'empty',
    colors: [],
    top: null,
    target,
    targetMet: target === null,
    conflict: false,
    message: target
      ? `空格：目标花纹要求这里最终由 ${target} 压在顶层`
      : '空格：可以沿格边把彩带拉到这里',
  };
}
