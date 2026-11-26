import type {
  ArrivalRecord,
  BeadColor,
  BeadState,
  BlockTrace,
  ChuteDef,
  FailureInfo,
  HintResult,
  LevelDef,
  MoveTrace,
  SetupState,
  Side,
  SimFrame,
  SimulationResult,
  StepTrace,
  SwitchEffectTrace,
  SwitchResolutionTrace,
} from './types';

export const oppositeSide = (side: Side): Side => (side === 'left' ? 'right' : 'left');

export function defaultSetup(level: LevelDef): SetupState {
  const tilts: Record<string, Side> = {};
  const colors: Record<string, BeadColor | null> = {};
  for (const chute of level.chutes) tilts[chute.id] = chute.initial;
  for (const slot of level.slots) colors[slot.id] = slot.color;
  return { tilts, colors };
}

export function cloneSetup(setup: SetupState): SetupState {
  return { tilts: { ...setup.tilts }, colors: { ...setup.colors } };
}

export function validateSetup(level: LevelDef, setup: SetupState): string[] {
  const problems: string[] = [];
  for (const slot of level.slots) {
    if (!setup.colors[slot.id]) problems.push(`发珠位 ${slot.id} 还没有放珠`);
  }
  for (const chute of level.chutes) {
    const tilt = setup.tilts[chute.id];
    if (tilt !== 'left' && tilt !== 'right') {
      problems.push(`斜槽 ${chute.id} 的朝向无效`);
    }
  }
  return problems;
}

export function validateLevelDefinition(level: LevelDef): string[] {
  const problems: string[] = [];
  const chuteIds = new Set<string>();
  const entries = new Map<string, string>();

  for (const node of Object.values(level.nodes)) {
    if (!node.id) problems.push('存在没有 id 的台面格');
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      problems.push(`台面格 ${node.id} 坐标无效`);
    }
  }

  for (const chute of level.chutes) {
    if (chuteIds.has(chute.id)) problems.push(`斜槽 id 重复: ${chute.id}`);
    chuteIds.add(chute.id);
    if (entries.has(chute.entry)) {
      problems.push(`格 ${chute.entry} 上有两条斜槽，规则要求一格一个出口`);
    }
    entries.set(chute.entry, chute.id);
    if (!level.nodes[chute.entry]) problems.push(`斜槽 ${chute.id} 的入口不存在: ${chute.entry}`);
    for (const side of ['left', 'right'] as Side[]) {
      const out = chute.outputs[side];
      if (out !== null && !level.nodes[out]) {
        problems.push(`斜槽 ${chute.id} 的 ${side} 出口指向不存在的格: ${out}`);
      }
    }
    for (const target of chute.trigger?.toggles ?? []) {
      if (!level.chutes.some((c) => c.id === target)) {
        problems.push(`开关 ${chute.trigger?.id} 指向不存在的斜槽: ${target}`);
      }
    }
  }

  for (const slot of level.slots) {
    if (!level.nodes[slot.node]) problems.push(`发珠位 ${slot.id} 指向不存在的格: ${slot.node}`);
  }

  for (const goal of level.goal) {
    if (goal.bin !== 'L' && goal.bin !== 'R') problems.push('目标出口必须是 L/R');
  }
  return problems;
}

function makeBeads(level: LevelDef, setup: SetupState): BeadState[] {
  return level.slots.map((slot, slotIndex) => ({
    id: `bead:${slot.id}`,
    slotId: slot.id,
    slotIndex,
    color: setup.colors[slot.id] ?? slot.color ?? 'red',
    releaseTick: slot.releaseTick,
    status: 'queued',
    node: null,
  }));
}

export function createInitialFrame(level: LevelDef, setup: SetupState): SimFrame {
  return {
    tick: 0,
    tilts: { ...setup.tilts },
    beads: makeBeads(level, setup),
    occupancy: {},
    arrivals: [],
    status: 'running',
  };
}

function compareClaimants(a: BeadState, b: BeadState, level: LevelDef): number {
  const rule = level.priority;
  if (rule.kind === 'color-rank') {
    const ai = rule.rank.indexOf(a.color);
    const bi = rule.rank.indexOf(b.color);
    const ar = ai === -1 ? rule.rank.length : ai;
    const br = bi === -1 ? rule.rank.length : bi;
    if (ar !== br) return ar - br;
  }
  if (a.releaseTick !== b.releaseTick) return a.releaseTick - b.releaseTick;
  if (a.slotIndex !== b.slotIndex) return a.slotIndex - b.slotIndex;
  return a.id.localeCompare(b.id);
}

interface Proposal {
  bead: BeadState;
  from: string;
  chute?: ChuteDef;
  side?: Side;
  dest?: string;
  deadend?: boolean;
  missingRoute?: boolean;
}

type OutcomeStatus = 'moved' | 'exited' | 'blocked' | 'jammed';

interface Outcome {
  status: OutcomeStatus;
  proposal: Proposal;
  block?: BlockTrace;
}

function evaluateGoal(
  level: LevelDef,
  arrivals: ArrivalRecord[],
  tick: number,
): { status: 'won' | 'failed'; failure?: FailureInfo } | undefined {
  for (let i = 0; i < arrivals.length; i += 1) {
    const arrival = arrivals[i];
    const expected = level.goal[i];
    if (!expected) {
      return {
        status: 'failed',
        failure: {
          code: 'wrong-arrival',
          tick,
          beadId: arrival.beadId,
          message: `第 ${i + 1} 个到达的是${colorName(arrival.color)}珠/${binName(arrival.bin)}口，但目标序列已经结束。`,
        },
      };
    }
    if (arrival.color !== expected.color || arrival.bin !== expected.bin) {
      let reason = '颜色或顺序不符';
      if (arrival.bin !== expected.bin) reason = '落进了错误出口';
      else if (arrival.color !== expected.color) reason = '到达颜色/顺序不对';
      const laterExpectedIndex = level.goal.findIndex(
        (g, idx) => idx >= i && g.color === arrival.color && g.bin === arrival.bin,
      );
      const orderHint =
        laterExpectedIndex > i
          ? `它是第 ${laterExpectedIndex + 1} 位才应出现的珠，现在提前到达，说明等待/竞争顺序还不对。`
          : '';
      return {
        status: 'failed',
        failure: {
          code: 'wrong-arrival',
          tick,
          beadId: arrival.beadId,
          message: `${reason}：第 ${i + 1} 个到达的是${colorName(arrival.color)}珠→${binName(
            arrival.bin,
          )}口；题面要求 ${colorName(expected.color)}珠→${binName(expected.bin)}口。${orderHint}`,
        },
      };
    }
  }

  if (level.goal.length > 0 && arrivals.length === level.goal.length) return { status: 'won' };
  return undefined;
}

export function colorName(color: BeadColor): string {
  return color === 'red' ? '红' : '蓝';
}

export function binName(bin: 'L' | 'R'): string {
  return bin === 'L' ? '左' : '右';
}

export function stepSimulation(level: LevelDef, prev: SimFrame): SimFrame {
  if (prev.status !== 'running') return prev;

  const nextTick = prev.tick + 1;
  const traceTick = prev.tick;
  const tilts: Record<string, Side> = { ...prev.tilts };
  const beads = prev.beads.map((bead) => ({ ...bead }));
  const arrivals = prev.arrivals.map((a) => ({ ...a }));

  const chuteByEntry = new Map<string, ChuteDef>();
  for (const chute of level.chutes) chuteByEntry.set(chute.entry, chute);

  const trace: StepTrace = {
    tick: traceTick,
    spawned: [],
    conflicts: [],
    moves: [],
    blocks: [],
    switchEffects: [],
    switchResolutions: [],
  };

  // Launch phase. A blocked launcher preserves queue order.
  const startOccupancy: Record<string, string> = { ...prev.occupancy };
  const sortedBeads = [...beads].sort((a, b) => a.slotIndex - b.slotIndex);
  for (const bead of sortedBeads) {
    if (bead.status !== 'queued') continue;
    if (bead.releaseTick > prev.tick) continue;
    const node = level.slots[bead.slotIndex]?.node ?? bead.node;
    if (!node) continue;
    const occupant = startOccupancy[node];
    if (occupant) {
      trace.blocks.push({
        tick: traceTick,
        beadId: bead.id,
        color: bead.color,
        kind: 'launch-blocked',
        target: node,
        blockerId: occupant,
        message: `${colorName(bead.color)}珠还在起点等待：发珠格 ${node} 尚未腾空，后面的同线珠不能越过它。`,
      });
      continue;
    }
    bead.status = 'active';
    bead.node = node;
    startOccupancy[node] = bead.id;
    trace.spawned.push(bead.id);
  }

  const activeBeads = beads.filter((b) => b.status === 'active' && b.node);
  const proposals = new Map<string, Proposal>();
  const destinationGroups = new Map<string, Proposal[]>();

  for (const bead of activeBeads) {
    const from = bead.node as string;
    const chute = chuteByEntry.get(from);
    let proposal: Proposal;
    if (!chute) {
      proposal = { bead, from, missingRoute: true };
    } else {
      const side = tilts[chute.id] ?? chute.initial;
      const dest = chute.outputs[side] ?? undefined;
      proposal = {
        bead,
        from,
        chute,
        side,
        dest,
        deadend: dest === undefined || dest === null,
      };
      if (dest) {
        const group = destinationGroups.get(dest) ?? [];
        group.push(proposal);
        destinationGroups.set(dest, group);
      }
    }
    proposals.set(bead.id, proposal);
  }

  const outcomes = new Map<string, Outcome>();

  // Resolve same-cell arbitration once, using the level's published rule.
  for (const [node, group] of destinationGroups) {
    if (group.length <= 1) continue;
    const sorted = [...group].sort((a, b) => compareClaimants(a.bead, b.bead, level));
    trace.conflicts.push({
      node,
      claimants: sorted.map((p) => p.bead.id),
      winnerId: sorted[0].bead.id,
      ruleLabel: level.priority.label,
    });
    for (let i = 1; i < sorted.length; i += 1) {
      const bead = sorted[i].bead;
      outcomes.set(bead.id, {
        status: 'blocked',
        proposal: sorted[i],
        block: {
          tick: traceTick,
          beadId: bead.id,
          color: bead.color,
          kind: 'lost-priority',
          target: node,
          winnerId: sorted[0].bead.id,
          message: `${colorName(bead.color)}珠与${colorName(sorted[0].bead.color)}珠同时争 ${node}，按「${level.priority.label}」留在原位。`,
        },
      });
    }
  }

  const resolving = new Set<string>();

  function resolve(proposal: Proposal): Outcome {
    const id = proposal.bead.id;
    const known = outcomes.get(id);
    if (known) return known;
    if (resolving.has(id)) {
      const outcome: Outcome = {
        status: 'blocked',
        proposal,
        block: {
          tick: traceTick,
          beadId: id,
          color: proposal.bead.color,
          kind: 'cycle',
          target: proposal.dest,
          message: '移动依赖形成环，台面规则要求所有斜槽向下，正常关卡不应出现。',
        },
      };
      outcomes.set(id, outcome);
      return outcome;
    }
    resolving.add(id);

    let outcome: Outcome;
    if (proposal.missingRoute) {
      outcome = {
        status: 'jammed',
        proposal,
        block: {
          tick: traceTick,
          beadId: id,
          color: proposal.bead.color,
          kind: 'missing-route',
          chuteId: proposal.chute?.id,
          target: proposal.from,
          message: `${colorName(proposal.bead.color)}珠所在的 ${proposal.from} 格没有可走的斜槽或出口，停在不通的台面上。`,
        },
      };
    } else if (proposal.deadend || !proposal.dest || !proposal.side) {
      outcome = {
        status: 'jammed',
        proposal,
        block: {
          tick: traceTick,
          beadId: id,
          color: proposal.bead.color,
          kind: 'deadend',
          chuteId: proposal.chute?.id,
          side: proposal.side,
          message: `${colorName(proposal.bead.color)}珠经过 ${proposal.chute?.id} 时，槽身倒向${
            proposal.side === 'left' ? '左' : '右'
          }侧，但这一端没有连接下面的格，珠子卡在不通的斜槽。`,
        },
      };
    } else {
      const dest = proposal.dest;
      const occupantId = startOccupancy[dest];
      if (occupantId && occupantId !== id) {
        const occupantProposal = proposals.get(occupantId);
        let occupantMoves = false;
        if (occupantProposal) {
          const occupantOutcome = resolve(occupantProposal);
          occupantMoves = occupantOutcome.status === 'moved' || occupantOutcome.status === 'exited';
        }
        if (!occupantMoves) {
          outcome = {
            status: 'blocked',
            proposal,
            block: {
              tick: traceTick,
              beadId: id,
              color: proposal.bead.color,
              kind: 'occupied',
              target: dest,
              blockerId: occupantId,
              message: `${colorName(proposal.bead.color)}珠在等 ${dest} 格腾开；前珠 ${occupantId} 尚未离开，因此这一拍不算失败。`,
            },
          };
          outcomes.set(id, outcome);
          resolving.delete(id);
          return outcome;
        }
      }

      const destNode = level.nodes[dest];
      outcome = { status: destNode?.kind === 'exit' ? 'exited' : 'moved', proposal };
    }

    outcomes.set(id, outcome);
    resolving.delete(id);
    return outcome;
  }

  for (const proposal of proposals.values()) resolve(proposal);

  // Commit bead positions and build trace rows.
  const moveTraces: MoveTrace[] = [];
  const newlyArrived: ArrivalRecord[] = [];

  for (const bead of beads) {
    if (bead.status !== 'active') continue;
    const proposal = proposals.get(bead.id);
    if (!proposal) continue;
    const outcome = outcomes.get(bead.id) ?? resolve(proposal);

    if (outcome.status === 'moved' && proposal.dest && proposal.side && proposal.chute) {
      bead.node = proposal.dest;
      bead.status = 'active';
      moveTraces.push({
        beadId: bead.id,
        color: bead.color,
        chuteId: proposal.chute.id,
        from: proposal.from,
        to: proposal.dest,
        side: proposal.side,
        exited: false,
      });
    } else if (outcome.status === 'exited' && proposal.dest && proposal.side && proposal.chute) {
      const node = level.nodes[proposal.dest];
      bead.node = null;
      bead.status = 'exited';
      bead.exitNode = proposal.dest;
      bead.bin = node.bin;
      bead.arrivedTick = nextTick;
      moveTraces.push({
        beadId: bead.id,
        color: bead.color,
        chuteId: proposal.chute.id,
        from: proposal.from,
        to: proposal.dest,
        side: proposal.side,
        exited: true,
      });
      newlyArrived.push({
        order: 0,
        tick: nextTick,
        beadId: bead.id,
        color: bead.color,
        bin: node.bin ?? 'L',
        node: proposal.dest,
      });
    } else {
      bead.node = proposal.from;
      bead.status = outcome.status === 'jammed' ? 'jammed' : 'active';
      if (outcome.block) trace.blocks.push(outcome.block);
    }
  }

  // Stable same-beat exit accounting. Same-cell ties were already arbitrated.
  newlyArrived.sort((a, b) => {
    const ba = beads.find((x) => x.id === a.beadId);
    const bb = beads.find((x) => x.id === b.beadId);
    if (ba && bb) {
      const cmp = compareClaimants(ba, bb, level);
      if (cmp !== 0) return cmp;
    }
    return a.node.localeCompare(b.node);
  });
  for (const arrival of newlyArrived) {
    arrival.order = arrivals.length + 1;
    arrivals.push(arrival);
  }

  trace.moves = moveTraces.sort((a, b) => a.beadId.localeCompare(b.beadId));
  trace.blocks.sort((a, b) => {
    const rank = { deadend: 0, 'missing-route': 1, cycle: 2, occupied: 3, 'lost-priority': 4, 'launch-blocked': 5 } as const;
    return rank[a.kind] - rank[b.kind] || a.beadId.localeCompare(b.beadId);
  });

  // Switches fire only for moves that really happened.
  const effects: SwitchEffectTrace[] = [];
  for (const move of trace.moves) {
    const chute = level.chutes.find((c) => c.id === move.chuteId);
    if (!chute?.trigger) continue;
    for (const targetChuteId of chute.trigger.toggles) {
      effects.push({
        switchId: chute.trigger.id,
        sourceChuteId: chute.id,
        beadId: move.beadId,
        targetChuteId,
      });
    }
  }
  effects.sort((a, b) =>
    a.switchId.localeCompare(b.switchId) ||
    a.targetChuteId.localeCompare(b.targetChuteId) ||
    a.beadId.localeCompare(b.beadId),
  );
  trace.switchEffects = effects;

  const effectByTarget = new Map<string, SwitchEffectTrace[]>();
  for (const effect of effects) {
    const list = effectByTarget.get(effect.targetChuteId) ?? [];
    list.push(effect);
    effectByTarget.set(effect.targetChuteId, list);
  }

  for (const targetChuteId of [...effectByTarget.keys()].sort()) {
    const sourceEffects = effectByTarget.get(targetChuteId) ?? [];
    const before = prev.tilts[targetChuteId] ?? level.chutes.find((c) => c.id === targetChuteId)?.initial ?? 'left';
    for (let i = 0; i < sourceEffects.length; i += 1) {
      tilts[targetChuteId] = oppositeSide(tilts[targetChuteId] ?? before);
    }
    const after = tilts[targetChuteId];
    const resolution: SwitchResolutionTrace = {
      targetChuteId,
      from: before,
      to: after,
      netToggles: sourceEffects.length,
      changed: before !== after,
      sources: sourceEffects,
      rule: '同拍效果按 switchId → targetChuteId 排序；每个来源执行一次 toggle，偶数次抵消。',
    };
    trace.switchResolutions.push(resolution);
  }

  const occupancy: Record<string, string> = {};
  for (const bead of beads) {
    if (bead.status === 'active' && bead.node) occupancy[bead.node] = bead.id;
  }

  let status: SimFrame['status'] = 'running';
  let failure: FailureInfo | undefined;

  const goalResult = evaluateGoal(level, arrivals, nextTick);
  if (goalResult) {
    status = goalResult.status;
    failure = goalResult.failure;
  }

  const jamBlock = trace.blocks.find((b) => b.kind === 'deadend' || b.kind === 'missing-route' || b.kind === 'cycle');
  if (status === 'running' && jamBlock) {
    status = 'failed';
    failure = {
      code: jamBlock.kind === 'deadend' ? 'deadend' : jamBlock.kind === 'missing-route' ? 'missing-route' : 'gridlock',
      tick: nextTick,
      beadId: jamBlock.beadId,
      message: jamBlock.message,
    };
  }

  const hasFutureQueued = beads.some((b) => b.status === 'queued' && b.releaseTick > prev.tick);
  if (
    status === 'running' &&
    trace.moves.length === 0 &&
    trace.spawned.length === 0 &&
    !hasFutureQueued
  ) {
    const firstBlock = trace.blocks[0];
    status = 'failed';
    failure = {
      code: 'gridlock',
      tick: nextTick,
      beadId: firstBlock?.beadId,
      message: firstBlock
        ? `台面已经卡死，不会再有变化：${firstBlock.message}`
        : '所有珠子都无法移动，且没有尚未发射的珠子或未触发的开关。',
    };
  }

  if (status === 'running' && nextTick >= level.maxTicks) {
    status = 'failed';
    failure = {
      code: 'timeout',
      tick: nextTick,
      message: `超过 ${level.maxTicks} 拍仍未完成目标；若珠子只是在等前格腾空，记录里会显示 occupied，而不会提前判失败。`,
    };
  }

  return {
    tick: nextTick,
    tilts,
    beads,
    occupancy,
    arrivals,
    status,
    failure,
    trace,
  };
}

export function simulateLevel(level: LevelDef, setup?: SetupState): SimulationResult {
  const effectiveSetup = setup ? cloneSetup(setup) : defaultSetup(level);
  const setupProblems = validateSetup(level, effectiveSetup);
  let frame = createInitialFrame(level, effectiveSetup);

  if (setupProblems.length > 0) {
    frame = {
      ...frame,
      status: 'failed',
      failure: {
        code: 'invalid-setup',
        tick: 0,
        message: setupProblems.join('；'),
      },
    };
    return {
      levelId: level.id,
      setup: effectiveSetup,
      frames: [frame],
      final: frame,
      won: false,
    };
  }

  const frames: SimFrame[] = [frame];
  let guard = 0;
  while (frame.status === 'running' && guard <= level.maxTicks + 2) {
    frame = stepSimulation(level, frame);
    frames.push(frame);
    guard += 1;
    if (frame.status !== 'running') break;
  }

  return {
    levelId: level.id,
    setup: effectiveSetup,
    frames,
    final: frame,
    won: frame.status === 'won',
  };
}

export function fingerprintResult(result: SimulationResult): string {
  return JSON.stringify({
    setup: result.setup,
    frames: result.frames.map((frame) => ({
      tick: frame.tick,
      status: frame.status,
      failure: frame.failure?.code,
      tilts: frame.tilts,
      occupancy: frame.occupancy,
      arrivals: frame.arrivals,
      beads: frame.beads.map((b) => ({
        id: b.id,
        status: b.status,
        node: b.node,
        bin: b.bin,
        arrivedTick: b.arrivedTick,
      })),
      trace: frame.trace
        ? {
            spawned: frame.trace.spawned,
            conflicts: frame.trace.conflicts,
            moves: frame.trace.moves,
            blocks: frame.trace.blocks.map(({ message: _message, ...rest }) => rest),
            switchResolutions: frame.trace.switchResolutions.map((r) => ({
              target: r.targetChuteId,
              from: r.from,
              to: r.to,
              net: r.netToggles,
              sources: r.sources.map((s) => s.switchId),
            })),
          }
        : undefined,
    })),
  });
}

export function findHint(level: LevelDef, current: SetupState): HintResult | null {
  const adjustable = level.chutes.filter((c) => c.adjustable !== false).map((c) => c.id);
  const editableSlots = level.slots.filter((s) => !s.lockedColor).map((s) => s.id);

  const tiltCombos = cartesianSides(adjustable);
  const colorCombos = cartesianColors(editableSlots);
  let best: HintResult | null = null;

  for (const tiltPart of tiltCombos) {
    for (const colorPart of colorCombos) {
      const setup = cloneSetup(current);
      Object.assign(setup.tilts, tiltPart);
      Object.assign(setup.colors, colorPart);
      // Locked slot colors are level truth even if current UI omitted them.
      for (const slot of level.slots) {
        if (slot.lockedColor && slot.color) setup.colors[slot.id] = slot.color;
      }
      const result = simulateLevel(level, setup);
      if (!result.won) continue;

      const tiltChanges = adjustable
        .map((chuteId) => {
          const from = current.tilts[chuteId] ?? level.chutes.find((c) => c.id === chuteId)!.initial;
          const to = setup.tilts[chuteId];
          return from !== to ? { chuteId, from, to } : null;
        })
        .filter((x): x is { chuteId: string; from: Side; to: Side } => x !== null);

      const colorChanges = editableSlots
        .map((slotId) => {
          const from = current.colors[slotId] ?? null;
          const to = setup.colors[slotId];
          return to && from !== to ? { slotId, from, to } : null;
        })
        .filter((x): x is { slotId: string; from: BeadColor | null; to: BeadColor } => x !== null);

      const cost = tiltChanges.length * 2 + colorChanges.length * 3;
      if (
        best &&
        (best.tiltChanges.length * 2 + best.colorChanges.length * 3 <= cost)
      ) {
        continue;
      }

      const summary = buildHintSummary(level, setup, result);
      best = { setup, tiltChanges, colorChanges, result, summary };
    }
  }

  return best;
}

function buildHintSummary(level: LevelDef, setup: SetupState, result: SimulationResult): string[] {
  const lines: string[] = [];
  for (const chute of level.chutes.filter((c) => c.adjustable !== false)) {
    lines.push(`${chute.id} 拨到${setup.tilts[chute.id] === 'left' ? '左' : '右'}侧`);
  }
  for (const slot of level.slots) {
    const color = setup.colors[slot.id];
    if (color) lines.push(`${slot.id} 放${colorName(color)}珠`);
  }
  const arrivals = result.final.arrivals
    .map((a) => `${a.tick}拍:${colorName(a.color)}→${binName(a.bin)}`)
    .join('，');
  lines.push(`引擎预演到达顺序：${arrivals}`);
  return lines;
}

function cartesianSides(ids: string[]): Array<Record<string, Side>> {
  if (ids.length === 0) return [{}];
  const [first, ...rest] = ids;
  const tail = cartesianSides(rest);
  const out: Array<Record<string, Side>> = [];
  for (const base of tail) {
    out.push({ ...base, [first]: 'left' });
    out.push({ ...base, [first]: 'right' });
  }
  return out;
}

function cartesianColors(ids: string[]): Array<Record<string, BeadColor>> {
  if (ids.length === 0) return [{}];
  const [first, ...rest] = ids;
  const tail = cartesianColors(rest);
  const out: Array<Record<string, BeadColor>> = [];
  for (const base of tail) {
    out.push({ ...base, [first]: 'red' });
    out.push({ ...base, [first]: 'blue' });
  }
  return out;
}
