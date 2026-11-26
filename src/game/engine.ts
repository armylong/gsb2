import { neighborCoord, slotCoordMap } from './geometry.js';
import type {
  BeatRecord,
  CheckItem,
  CollisionGroup,
  CollisionRecord,
  Dir,
  EditAction,
  FlagTiming,
  LevelDef,
  Placement,
  ReplayRecord,
  RuntimeKind,
  RuntimePiece,
  SimulationResult,
  Snapshot,
  TimingSpec,
} from './types.js';

export const BEAT_MS = 100;

export const FALL_TIMING: Record<Exclude<RuntimeKind, 'post'>, { contact: number; land: number; label: string }> = {
  launcher: { contact: 2, land: 5, label: '启动片 0.5s' },
  thin: { contact: 3, land: 6, label: '细木片 0.6s' },
  wide: { contact: 4, land: 9, label: '宽木片 0.9s' },
  gate: { contact: 3, land: 7, label: '单向片 0.7s' },
  flag: { contact: 0, land: 8, label: '终点旗 0.8s' },
};

const ALL_TIMING: Record<RuntimeKind, TimingSpec> = {
  launcher: { beatMs: BEAT_MS, contactAfterBeats: 2, landAfterBeats: 5 },
  thin: { beatMs: BEAT_MS, contactAfterBeats: 3, landAfterBeats: 6 },
  wide: { beatMs: BEAT_MS, contactAfterBeats: 4, landAfterBeats: 9 },
  gate: { beatMs: BEAT_MS, contactAfterBeats: 3, landAfterBeats: 7 },
  flag: { beatMs: BEAT_MS, contactAfterBeats: 0, landAfterBeats: 8 },
  post: { beatMs: BEAT_MS, contactAfterBeats: 0, landAfterBeats: 0 },
};

const MAX_BEATS = 240;

interface RawCollision {
  record: CollisionRecord;
}

interface ScheduledContact {
  beat: number;
  sourceSlotId: string;
}

export function validatePlacement(level: LevelDef, placement: Placement[]): string[] {
  const errors: string[] = [];
  const slotIds = new Set(level.slots.map((s) => s.id));
  const fixedSlots = new Set(level.fixed.map((f) => f.slotId));
  const seen = new Set<string>();
  const counts = { thin: 0, wide: 0 };

  for (const p of placement) {
    if (!slotIds.has(p.slotId)) errors.push(`摆放引用了不存在的槽位：${p.slotId}`);
    if (seen.has(p.slotId)) errors.push(`同一槽位重复摆放：${p.slotId}`);
    seen.add(p.slotId);
    if (fixedSlots.has(p.slotId)) errors.push(`固定物件槽位不能摆木片：${p.slotId}`);
    const slot = level.slots.find((s) => s.id === p.slotId);
    if (p.type === 'wide' && slot && !slot.wideBase) {
      errors.push(`宽木片只能放在指定宽槽：${p.slotId}`);
    }
    counts[p.type] += 1;
  }

  if (counts.thin > level.inventory.thin) errors.push(`细木片超出库存：${counts.thin}/${level.inventory.thin}`);
  if (counts.wide > level.inventory.wide) errors.push(`宽木片超出库存：${counts.wide}/${level.inventory.wide}`);
  return errors;
}

function makeRuntime(
  slotId: string,
  kind: RuntimeKind,
  facing: Dir | null,
  outputs: Dir[],
): RuntimePiece {
  return {
    slotId,
    kind,
    status: kind === 'post' ? 'standing' : 'idle',
    facing,
    outputs,
    touchedBeat: null,
    contactBeat: null,
    landBeat: null,
    incomingDir: null,
    triggeredByCollisionId: null,
    acceptedHitCount: 0,
    collisionIds: [],
  };
}

function snapshot(beat: number, runtime: Map<string, RuntimePiece>, forbidden: string[]): Snapshot {
  return {
    beat,
    pieces: [...runtime.values()]
      .map((p) => ({ ...p, outputs: [...p.outputs], collisionIds: [...p.collisionIds] }))
      .sort((a, b) => a.slotId.localeCompare(b.slotId)),
    forbiddenTouchedSlotIds: [...forbidden].sort(),
  };
}

export function simulate(level: LevelDef, placement: Placement[]): SimulationResult {
  const validationErrors = validatePlacement(level, placement);
  const coordMap = slotCoordMap(level.slots);
  const slotById = new Map(level.slots.map((s) => [s.id, s]));
  const fixedBySlot = new Map(level.fixed.map((f) => [f.slotId, f]));
  const runtime = new Map<string, RuntimePiece>();
  const forbiddenSet = new Set(level.slots.filter((s) => s.forbidden).map((s) => s.id));
  const forbiddenTouched = new Set<string>();
  // 直接摆在禁碰槽也属于违反“禁碰”；模拟中碰撞进入同样会追加。
  for (const p of placement) {
    if (forbiddenSet.has(p.slotId)) forbiddenTouched.add(p.slotId);
  }

  for (const f of level.fixed) {
    const outputs: Dir[] = f.kind === 'launcher' || f.kind === 'gate' ? (f.facing ? [f.facing] : []) : [];
    runtime.set(f.slotId, makeRuntime(f.slotId, f.kind, f.facing ?? null, outputs));
  }

  for (const p of placement) {
    const outputs = p.type === 'wide' && p.facing ? [p.facing, rotateCW(p.facing)] : p.facing ? [p.facing] : [];
    runtime.set(p.slotId, makeRuntime(p.slotId, p.type, p.facing, outputs));
  }

  const collisions: CollisionRecord[] = [];
  const groups: CollisionGroup[] = [];
  const beats: BeatRecord[] = [];
  const snapshots: Snapshot[] = [];
  const scheduledContacts: ScheduledContact[] = [];
  let collisionSeq = 0;

  const trigger = (
    slotId: string,
    beat: number,
    collisionId: string | null,
    incomingDir: Dir | null,
  ): RuntimePiece | null => {
    const piece = runtime.get(slotId);
    if (!piece || piece.status === 'falling' || piece.status === 'fallen') return null;
    const t = ALL_TIMING[piece.kind];
    piece.status = 'falling';
    piece.touchedBeat = beat;
    piece.contactBeat = t.contactAfterBeats > 0 ? beat + t.contactAfterBeats : null;
    piece.landBeat = beat + t.landAfterBeats;
    piece.incomingDir = incomingDir;
    piece.triggeredByCollisionId = collisionId;
    piece.acceptedHitCount += 1;
    if (piece.contactBeat !== null) {
      scheduledContacts.push({ beat: piece.contactBeat, sourceSlotId: slotId });
    }
    return piece;
  };

  const launcher = level.fixed.find((f) => f.kind === 'launcher');
  if (launcher) trigger(launcher.slotId, 0, null, launcher.facing ? oppositeDir(launcher.facing) : null);

  let lastBeat = 0;

  for (let beat = 0; beat <= MAX_BEATS; beat += 1) {
    lastBeat = beat;
    const beatCollisionIds: string[] = [];
    const touchedSlotIds: string[] = [];
    const landedSlotIds: string[] = [];

    const dueContacts = scheduledContacts
      .filter((c) => c.beat === beat)
      .sort((a, b) => a.sourceSlotId.localeCompare(b.sourceSlotId));
    for (let i = scheduledContacts.length - 1; i >= 0; i -= 1) {
      if (scheduledContacts[i]?.beat === beat) scheduledContacts.splice(i, 1);
    }

    const raw: RawCollision[] = [];

    for (const contact of dueContacts) {
      const source = runtime.get(contact.sourceSlotId);
      const sourceSlot = slotById.get(contact.sourceSlotId);
      if (!source || !sourceSlot) continue;
      const outputDirs = [...source.outputs].sort((a, b) => DIR_ORDER[a] - DIR_ORDER[b]);

      for (const dir of outputDirs) {
        const nc = neighborCoord(sourceSlot.x, sourceSlot.y, dir);
        const targetSlot = coordMap.get(`${nc.x},${nc.y}`) ?? null;
        collisionSeq += 1;
        const id = `col-${String(collisionSeq).padStart(3, '0')}`;
        const groupId = targetSlot ? `g-b${beat}-${targetSlot.id}` : `g-b${beat}-empty-${collisionSeq}`;
        if (targetSlot?.forbidden) forbiddenTouched.add(targetSlot.id);
        const record: CollisionRecord = {
          id,
          beat,
          groupId,
          sourceSlotId: source.slotId,
          targetSlotId: targetSlot?.id ?? null,
          dir,
          outcome: 'empty',
          simultaneous: false,
          forbidden: targetSlot?.forbidden ?? false,
          note: targetSlot ? '等待判定' : '邻格没有固定槽位',
        };
        collisions.push(record);
        beatCollisionIds.push(id);
        raw.push({ record });
      }
    }

    const grouped = new Map<string, CollisionRecord[]>();
    for (const item of raw) {
      const key = item.record.groupId;
      const list = grouped.get(key) ?? [];
      list.push(item.record);
      grouped.set(key, list);
    }

    const groupKeys = [...grouped.keys()].sort();
    for (const groupId of groupKeys) {
      const records = grouped.get(groupId) ?? [];
      const targetSlotId = records[0]?.targetSlotId ?? null;
      const simultaneous = records.length > 1 && targetSlotId !== null;
      let triggeredSlotId: string | null = null;
      let blockedReason: string | null = null;

      for (const r of records) {
        r.simultaneous = simultaneous;
        const targetSlot = r.targetSlotId ? slotById.get(r.targetSlotId) : undefined;
        if (!targetSlot) {
          r.outcome = 'empty';
          r.note = '邻格没有槽位，碰撞落空';
          continue;
        }

        const fixed = fixedBySlot.get(targetSlot.id);
        const target = runtime.get(targetSlot.id);

        if (fixed?.kind === 'post' || target?.kind === 'post') {
          r.outcome = 'blocked-post';
          r.note = `挡柱挡住了从${dirText(r.dir)}来的碰撞`;
          blockedReason = r.note;
          target?.collisionIds.push(r.id);
          continue;
        }

        if (fixed?.kind === 'gate' && fixed.acceptDir && r.dir !== fixed.acceptDir) {
          r.outcome = 'blocked-wrong-side';
          r.note = `单向片只允许从${dirText(oppositeDir(fixed.acceptDir))}侧沿${fixed.acceptDir}碰开`;
          blockedReason = r.note;
          target?.collisionIds.push(r.id);
          continue;
        }

        if (!target || target.status === 'idle') {
          // 可触发；同组稍后统一选择唯一一路。
          continue;
        }

        target.collisionIds.push(r.id);
        if (target.status === 'falling') {
          r.outcome = 'already-falling';
          r.note = '该片正在倒下，后续路线不重复触发';
        } else if (target.status === 'fallen') {
          r.outcome = 'already-fallen';
          r.note = '撞上已经躺下的片，不会再触发一遍';
        } else {
          r.outcome = 'blocked-post';
          r.note = '固定挡柱无法被撞倒';
          blockedReason = r.note;
        }
      }

      const admissible = records
        .filter((r) => {
          if (r.outcome !== 'empty' && r.note === '等待判定') return true;
          // 初始占位的可触发记录尚未设置 outcome；上面的 idle 分支保持 empty + 等待判定。
          const target = r.targetSlotId ? runtime.get(r.targetSlotId) : undefined;
          return Boolean(target && target.status === 'idle' && r.outcome === 'empty' && r.note === '等待判定');
        })
        .sort((a, b) => (a.sourceSlotId ?? '').localeCompare(b.sourceSlotId ?? ''));

      if (targetSlotId && admissible.length > 0) {
        const winner = admissible[0];
        if (winner) {
          const target = runtime.get(targetSlotId);
          if (target && target.status === 'idle') {
            const triggered = trigger(targetSlotId, beat, winner.id, winner.dir);
            if (triggered) {
              touchedSlotIds.push(targetSlotId);
              triggeredSlotId = targetSlotId;
              winner.outcome = 'triggered';
              winner.note = simultaneous
                ? '同拍多路到达：这一路被记为首次触发'
                : '碰撞成功，木片开始倒下';
              target.collisionIds.push(winner.id);

              for (const loser of admissible.slice(1)) {
                loser.outcome = 'merged-same-beat';
                loser.note = '同一拍几乎同时碰到，已合并为一次，不重复触发';
                target.collisionIds.push(loser.id);
              }
            }
          }
        }
      } else if (targetSlotId) {
        const target = runtime.get(targetSlotId);
        if (target && records.every((r) => r.outcome === 'empty' && r.note === '等待判定')) {
          for (const r of records) {
            r.outcome = 'empty';
            r.note = '空槽：这里没有可被碰倒的木片';
          }
        }
      }

      // 兜底：仍为“等待判定”的记录按空槽处理。
      for (const r of records) {
        if (r.note === '等待判定') {
          r.outcome = 'empty';
          r.note = r.targetSlotId && !runtime.has(r.targetSlotId) ? '空槽：没有可触发木片' : '该碰撞没有产生新的触发';
        }
      }

      groups.push({
        id: groupId,
        beat,
        targetSlotId,
        collisionIds: records.map((r) => r.id),
        simultaneous,
        triggeredSlotId,
        blockedReason,
      });
    }

    // 落地阶段放在同拍碰撞判定之后。
    for (const piece of runtime.values()) {
      if (piece.status === 'falling' && piece.landBeat === beat) {
        piece.status = 'fallen';
        landedSlotIds.push(piece.slotId);
      }
    }

    beats.push({ beat, collisionIds: beatCollisionIds, touchedSlotIds, landedSlotIds });
    snapshots[beat] = snapshot(beat, runtime, [...forbiddenTouched]);

    const hasFutureContact = scheduledContacts.some((c) => c.beat > beat);
    const hasFallingFutureLand = [...runtime.values()].some(
      (p) => p.status === 'falling' && p.landBeat !== null && p.landBeat > beat,
    );
    if (beat > 0 && !hasFutureContact && !hasFallingFutureLand) {
      lastBeat = beat;
      break;
    }
  }

  const flags: FlagTiming[] = level.win.requiredFlags.map((flagId, index) => {
    const fixed = level.fixed.find((f) => (f.flagId ?? f.id) === flagId);
    const slotId = fixed?.slotId;
    const piece = slotId ? runtime.get(slotId) : undefined;
    const touchedBeat = piece?.touchedBeat ?? null;
    const landBeat = piece?.landBeat ?? null;
    return {
      flagId,
      order: index + 1,
      touchedBeat,
      landedBeat: landBeat,
      touchedMs: touchedBeat === null ? null : touchedBeat * BEAT_MS,
      landedMs: landBeat === null ? null : landBeat * BEAT_MS,
    };
  });

  const checks = buildChecks(level, placement, validationErrors, flags, forbiddenTouched);
  const win = checks.every((c) => c.pass);

  return {
    levelId: level.id,
    win,
    lastBeat,
    pieceCount: placement.length,
    snapshots: snapshots.filter((s): s is Snapshot => Boolean(s)),
    beats,
    collisions,
    groups,
    flags,
    forbiddenTouchedSlotIds: [...forbiddenTouched].sort(),
    checks,
    timing: ALL_TIMING,
    beatMs: BEAT_MS,
  };
}

function buildChecks(
  level: LevelDef,
  placement: Placement[],
  validationErrors: string[],
  flags: FlagTiming[],
  forbiddenTouched: Set<string>,
): CheckItem[] {
  const legalityPass = validationErrors.length === 0;
  const flagsLanded = flags.filter((f) => f.landedBeat !== null);
  const [first, second] = flags;
  const firstLand = first?.landedBeat ?? null;
  const secondLand = second?.landedBeat ?? null;
  const orderPass = firstLand !== null && secondLand !== null && firstLand < secondLand;
  const intervalDelta = firstLand !== null && secondLand !== null ? secondLand - firstLand : null;
  const intervalPass =
    intervalDelta !== null &&
    intervalDelta >= level.win.minIntervalBeats &&
    (level.win.maxIntervalBeats === undefined || intervalDelta <= level.win.maxIntervalBeats);
  const forbiddenPass = forbiddenTouched.size === 0;
  const piecePass = placement.length <= level.win.maxPieces;

  return [
    {
      id: 'legality',
      label: '摆放合法',
      pass: legalityPass,
      detail: legalityPass ? '槽位、宽槽和库存均合法' : validationErrors.join('；'),
    },
    {
      id: 'flags',
      label: '两面旗都倒下',
      pass: flagsLanded.length === 2,
      detail: flagsLanded.length === 2 ? '两面终点旗均已落地' : `只有 ${flagsLanded.length}/2 面旗倒下`,
    },
    {
      id: 'order',
      label: `先 ${level.win.requiredFlags[0] ?? 'A'} 后 ${level.win.requiredFlags[1] ?? 'B'}`,
      pass: orderPass,
      detail:
        firstLand === null || secondLand === null
          ? '仍有旗未倒下'
          : firstLand < secondLand
            ? `落地拍 ${firstLand} → ${secondLand}`
            : firstLand === secondLand
              ? `两旗同在第 ${firstLand} 拍落地，先后不成立`
              : `顺序反了：${first?.flagId ?? '第一旗'} 在第 ${firstLand} 拍，${second?.flagId ?? '第二旗'} 在第 ${secondLand} 拍`,
    },
    {
      id: 'interval',
      label: `间隔 ≥ ${level.win.minIntervalBeats} 拍`,
      pass: intervalPass,
      detail:
        intervalDelta === null
          ? '缺少一面旗，无法量间隔'
          : `实际间隔 ${intervalDelta} 拍（${(intervalDelta * BEAT_MS) / 1000}s）` +
            (intervalDelta < level.win.minIntervalBeats ? '；第二面旗太早倒！' : ''),
    },
    {
      id: 'forbidden',
      label: '不碰禁碰槽',
      pass: forbiddenPass,
      detail: forbiddenPass ? '没有碰撞进入禁碰槽' : `碰到：${[...forbiddenTouched].join(', ')}`,
    },
    {
      id: 'pieces',
      label: `用片 ≤ ${level.win.maxPieces}`,
      pass: piecePass,
      detail: `当前 ${placement.length} 片，上限 ${level.win.maxPieces} 片`,
    },
  ];
}

export function createReplay(
  level: LevelDef,
  placement: Placement[],
  actions: EditAction[],
  simulation?: SimulationResult,
): ReplayRecord {
  const result = simulation ?? simulate(level, placement);
  const baseline = lastBaselineIndex(actions);
  return {
    schema: 'wood-relay-replay/v1',
    levelId: level.id,
    levelName: level.name,
    placement: placement.map((p) => ({ ...p })),
    actions: actions.map((a) => ({ ...a })),
    generatedLogicalBeat: actions.length,
    result,
    sameBeatCollisionGroups: result.groups.filter((g) => g.simultaneous),
    winningActions: actions.slice(baseline).map((a) => ({ ...a })),
  };
}

export function lastBaselineIndex(actions: EditAction[]): number {
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    if (actions[i]?.type === 'clear' || actions[i]?.type === 'load-sample') return i;
  }
  return 0;
}

export function canonicalReplayJson(replay: ReplayRecord): string {
  return JSON.stringify(replay, null, 2);
}

function rotateCW(dir: Dir): Dir {
  const map: Record<Dir, Dir> = { N: 'E', E: 'S', S: 'W', W: 'N' };
  return map[dir];
}

function oppositeDir(dir: Dir): Dir {
  const map: Record<Dir, Dir> = { N: 'S', E: 'W', S: 'N', W: 'E' };
  return map[dir];
}

function dirText(dir: Dir): string {
  return { N: '北', E: '东', S: '南', W: '西' }[dir];
}

const DIR_ORDER: Record<Dir, number> = { N: 0, E: 1, S: 2, W: 3 };
