import {
  angleAt,
  angleDistance,
  eaveAt,
  isInsideArc,
  phaseAt,
  roundAt,
} from './geometry';
import type {
  BeatReport,
  CellId,
  Command,
  GameState,
  LossEvent,
  ObservationTick,
  QualifiedRecord,
  ScopeId,
  ScopeState,
  SimulationResult,
  VisibilityRun,
  LevelDef,
} from './types';

export const CELL_INDEX: Record<CellId, number> = { w0: 0, walk: 1, w1: 2 };
export const INDEX_CELL: CellId[] = ['w0', 'walk', 'w1'];

export function cellWindowIndex(cell: CellId): 0 | 1 | null {
  return cell === 'w0' ? 0 : cell === 'w1' ? 1 : null;
}

export function createInitialState(level: LevelDef): GameState {
  return {
    elapsed: 0,
    scopes: level.scopes.map((s) => ({
      id: s.id,
      cell: s.startCell,
      heading: s.startHeading,
      filter: s.filter,
      observing: false,
      targetId: null,
      streak: 0,
      streakStartBeat: null,
      attemptQualified: false,
    })) as [ScopeState, ScopeState],
    bodies: level.bodies.map((b) => ({ id: b.id, angle: b.initialAngle })),
    records: [],
    losses: [],
  };
}

function scope(state: GameState, id: ScopeId): ScopeState {
  return state.scopes[id];
}

function addLoss(
  state: GameState,
  beat: number,
  init: Omit<LossEvent, 'id' | 'beat'>,
): LossEvent {
  const event: LossEvent = {
    id: `loss-${beat}-${state.losses.length}-${init.code}`,
    beat,
    ...init,
  };
  state.losses.push(event);
  return event;
}

interface CandidateResult {
  ok: boolean;
  code: string;
  message: string;
  bodyId?: string;
  angle?: number;
}

export function acquireCandidate(
  level: LevelDef,
  state: GameState,
  scopeState: ScopeState,
): CandidateResult {
  const windowIndex = cellWindowIndex(scopeState.cell);
  if (windowIndex === null) {
    return {
      ok: false,
      code: 'on-walkway',
      message: '望远镜还在共用走台上，路径未走完，不能开始观测。',
    };
  }

  const win = level.windows[windowIndex];
  if (!isInsideArc(scopeState.heading, win.centre, win.halfWidth)) {
    return {
      ok: false,
      code: 'heading-outside-window',
      message: `镜头朝向在${win.name}的视野之外，先把镜子转回窗格。`,
    };
  }

  let best: { id: string; angle: number; distance: number } | null = null;
  for (const def of level.bodies) {
    if (!def.designated) continue;
    const body = state.bodies.find((b) => b.id === def.id);
    if (!body) continue;
    if (!isInsideArc(body.angle, win.centre, win.halfWidth)) continue;
    const distance = angleDistance(body.angle, scopeState.heading);
    if (distance > level.aimTolerance) continue;
    if (!best || distance < best.distance) {
      best = { id: body.id, angle: body.angle, distance };
    }
  }

  if (!best) {
    return {
      ok: false,
      code: 'no-target-in-crosshair',
      message: '十字准星内没有可开始观测的指定天体；请预判下一拍位置或继续转向。',
    };
  }

  return { ok: true, code: 'ok', message: '已锁定目标。', bodyId: best.id, angle: best.angle };
}

function validateMove(
  state: GameState,
  scopeState: ScopeState,
  dir: -1 | 1,
): { ok: boolean; code: string; message: string; targetCell?: CellId } {
  const from = CELL_INDEX[scopeState.cell];
  const to = from + dir;
  if (to < 0 || to > 2) {
    return { ok: false, code: 'path-end', message: '这个方向已经是走台尽头，没有可搬去的位置。' };
  }
  const targetCell = INDEX_CELL[to];
  const other = state.scopes[scopeState.id === 0 ? 1 : 0];

  if (targetCell === 'walk' && other.cell === 'walk') {
    return {
      ok: false,
      code: 'walkway-occupied',
      message: '共用走台正被另一台望远镜占用：请先让它完全搬到窗位，腾出走台。',
    };
  }
  if (targetCell !== 'walk' && other.cell === targetCell) {
    return {
      ok: false,
      code: 'window-occupied',
      message: '该窗位已有一台望远镜；请先协调另一台镜子的位置。',
    };
  }
  return { ok: true, code: 'ok', message: '可以搬镜。', targetCell };
}

function stopSessionForMoveOrRotate(
  state: GameState,
  beat: number,
  scopeState: ScopeState,
  code: string,
  message: string,
): void {
  if (scopeState.observing && scopeState.streak > 0 && scopeState.targetId) {
    addLoss(state, beat, {
      scopeId: scopeState.id,
      targetId: scopeState.targetId,
      code,
      message,
      kind: 'interruption',
      brokeStreak: scopeState.streak,
    });
  }
  scopeState.observing = false;
  scopeState.targetId = null;
  scopeState.streak = 0;
  scopeState.streakStartBeat = null;
  scopeState.attemptQualified = false;
}

export function stepState(
  level: LevelDef,
  previous: GameState,
  rawCommand: Command | null | undefined,
  beat: number = previous.elapsed,
): BeatReport {
  const state: GameState = structuredClone(previous);
  const command: Command | null = rawCommand ?? null;
  state.elapsed = beat + 1;

  // The simplified sky advances deterministically before the beat is settled.
  for (const body of state.bodies) {
    const def = level.bodies.find((b) => b.id === body.id)!;
    body.angle = angleAt(def.initialAngle, def.speed, def.dir, state.elapsed);
  }

  const phase = phaseAt(level, beat);
  const round = roundAt(level, beat);
  const ticks: ObservationTick[] = [];
  const beatLosses: LossEvent[] = [];
  let accepted = true;
  let rejectionCode: string | undefined;
  let rejection: string | undefined;
  const busyCode: [string | null, string | null] = [null, null];
  const brokeOnBusy: [number, number] = [0, 0];

  const reject = (code: string, message: string, kind: LossEvent['kind'] = 'conflict') => {
    accepted = false;
    rejectionCode = code;
    rejection = message;
    const event = addLoss(state, beat, {
      code,
      message,
      kind,
      scopeId: command?.scopeId,
    });
    beatLosses.push(event);
  };

  if (command && command.type !== 'idle') {
    if (command.scopeId === undefined) {
      reject('missing-scope', '这条动作没有指定望远镜。');
    } else {
      const s = scope(state, command.scopeId);

      if (command.type === 'rotate') {
        const dir = command.dir ?? 1;
        stopSessionForMoveOrRotate(
          state,
          beat,
          s,
          'manual-rotate',
          '手动转向使镜头偏离锁定目标，当前连续观测中断。',
        );
        s.heading = (s.heading + dir * level.scopes[s.id].slew + 360) % 360;
      } else if (command.type === 'filter') {
        const nextFilter = command.filter;
        if (!nextFilter) {
          reject('missing-filter', '没有指定要切换的滤片。');
        } else if (nextFilter === s.filter) {
          reject('same-filter', `已经在使用${filterLabel(nextFilter)}，本拍不必重复切换。`);
        } else {
          brokeOnBusy[s.id] = s.streak;
          s.filter = nextFilter;
          s.streak = 0;
          s.streakStartBeat = null;
          s.attemptQualified = false;
          busyCode[s.id] = 'filter-switch';
        }
      } else if (command.type === 'move') {
        const dir = command.dir ?? 1;
        const moveCheck = validateMove(state, s, dir);
        if (!moveCheck.ok || !moveCheck.targetCell) {
          reject(moveCheck.code, moveCheck.message, moveCheck.code === 'walkway-occupied' ? 'conflict' : 'missed');
        } else {
          stopSessionForMoveOrRotate(
            state,
            beat,
            s,
            'move-interrupted',
            '搬镜过程中不能观测，当前连续观测中断。',
          );
          s.cell = moveCheck.targetCell;
        }
      } else if (command.type === 'stop') {
        stopSessionForMoveOrRotate(state, beat, s, 'manual-stop', '手动停止观测，连续段结束。');
      } else if (command.type === 'start') {
        const candidate = acquireCandidate(level, state, s);
        if (!candidate.ok || !candidate.bodyId || candidate.angle === undefined) {
          reject(candidate.code, candidate.message, 'missed');
        } else {
          s.observing = true;
          s.targetId = candidate.bodyId;
          s.streak = 0;
          s.streakStartBeat = null;
          s.attemptQualified = false;
          s.heading = candidate.angle;
        }
      }
    }
  }

  // A locked telescope tracks the simplified body automatically after acquisition.
  for (const s of state.scopes) {
    if (s.observing && s.targetId) {
      const body = state.bodies.find((b) => b.id === s.targetId);
      if (body) s.heading = body.angle;
    }
  }

  // Settle all active observation records for this beat.
  for (const s of state.scopes) {
    if (!s.observing) continue;

    const targetDef = level.bodies.find((b) => b.id === s.targetId);
    const targetState = state.bodies.find((b) => b.id === s.targetId);
    if (!targetDef || !targetState) {
      const code = 'target-missing';
      const message = '锁定的天体不存在。';
      const event = addLoss(state, beat, {
        scopeId: s.id,
        targetId: s.targetId ?? undefined,
        code,
        message,
        kind: 'missed',
      });
      beatLosses.push(event);
      ticks.push({ beat, scopeId: s.id, targetId: s.targetId, credited: false, code, message, streak: s.streak });
      s.observing = false;
      continue;
    }

    let code = 'ok';
    let message = '观测有效';

    if (busyCode[s.id]) {
      code = busyCode[s.id]!;
      message = '本拍用来切换滤片，不能同时完成观测；新滤片从下一拍起才能累计。';
    } else if (phase === 'day') {
      code = 'daylight';
      message = '固定回合走到白昼，星光被天光盖住，连续观测中断。';
    } else if (s.cell === 'walk') {
      code = 'on-walkway';
      message = '望远镜仍在共用走台上，路径未走完，不能提交观测。';
    } else {
      const windowIndex = cellWindowIndex(s.cell)!;
      const win = level.windows[windowIndex];
      if (!isInsideArc(targetState.angle, win.centre, win.halfWidth)) {
        code = 'outside-window';
        message = `${targetDef.name}已转出${win.name}的交界，本拍捡不到。`;
      } else if (eaveAt(targetState.angle, win.centre, win.eave)) {
        code = 'eave';
        message = `${win.eave.label}在这一拍遮住${targetDef.name}，连续观测中断。`;
      } else if (!isInsideArc(s.heading, win.centre, win.halfWidth)) {
        code = 'heading-outside-window';
        message = '镜头朝向落到窗格视野之外，本拍捡不到天体。';
      } else if (angleDistance(targetState.angle, s.heading) > level.aimTolerance + 1e-7) {
        code = 'misaligned';
        message = '镜头没有跟上目标，本拍未累计。';
      } else if (s.filter !== targetDef.filter) {
        code = 'filter-mismatch';
        message = `滤片不对：${targetDef.name}需要${filterLabel(targetDef.filter)}，当前是${filterLabel(s.filter)}。`;
      }
    }

    if (code !== 'ok') {
      const broke = busyCode[s.id] ? brokeOnBusy[s.id] : s.streak;
      s.streak = 0;
      s.streakStartBeat = null;
      s.attemptQualified = false;
      const kind = broke > 0 ? 'interruption' : 'missed';
      const event = addLoss(state, beat, {
        scopeId: s.id,
        targetId: targetDef.id,
        code,
        message,
        kind,
        brokeStreak: broke || undefined,
      });
      beatLosses.push(event);
      ticks.push({
        beat,
        scopeId: s.id,
        targetId: targetDef.id,
        credited: false,
        code,
        message,
        streak: 0,
      });
      continue;
    }

    s.streak += 1;
    if (s.streakStartBeat === null) s.streakStartBeat = beat - s.streak + 1;
    let record: QualifiedRecord | undefined;
    let recordKey: string | undefined;

    if (s.streak >= targetDef.requiredBeats && !s.attemptQualified) {
      recordKey = `${targetDef.id}-${s.id}-${beat - targetDef.requiredBeats + 1}-${beat}`;
      record = {
        key: recordKey,
        targetId: targetDef.id,
        targetName: targetDef.name,
        scopeId: s.id,
        scopeName: level.scopes[s.id].name,
        startBeat: beat - targetDef.requiredBeats + 1,
        endBeat: beat,
        beats: targetDef.requiredBeats,
        filter: s.filter,
      };
      state.records.push(record);
      s.attemptQualified = true;
    }

    ticks.push({
      beat,
      scopeId: s.id,
      targetId: targetDef.id,
      credited: true,
      code: 'ok',
      message: `连续观测 ${s.streak} 拍`,
      streak: s.streak,
      recordKey,
    });

    // A qualified segment is submitted immediately. Its immutable record stays
    // even if the player later starts another segment and an eave/filter breaks it.
    if (record) {
      s.observing = false;
      s.targetId = null;
      s.streak = 0;
      s.streakStartBeat = null;
      s.attemptQualified = false;
    }
  }

  return {
    beat,
    round,
    phase,
    command: command ?? null,
    accepted,
    rejectionCode,
    rejection,
    ticks,
    losses: beatLosses,
    state,
  };
}

export function filterLabel(filter: string): string {
  return filter === 'red' ? '红滤片' : filter === 'blue' ? '蓝滤片' : '白光';
}

export function getVisibilityRuns(level: LevelDef): VisibilityRun[] {
  const runs: VisibilityRun[] = [];

  for (const body of level.bodies) {
    for (let windowIndex = 0 as 0 | 1; windowIndex < 2; windowIndex = (windowIndex + 1) as 0 | 1) {
      const win = level.windows[windowIndex];
      let current: VisibilityRun | null = null;

      const close = (endBeat: number) => {
        if (current) {
          current.endBeat = endBeat;
          current.beats = current.endBeat - current.startBeat + 1;
          runs.push(current);
          current = null;
        }
      };

      for (let beat = 0; beat < level.totalBeats; beat += 1) {
        const angle = angleAt(body.initialAngle, body.speed, body.dir, beat + 1);
        const inside = isInsideArc(angle, win.centre, win.halfWidth);
        if (!inside) {
          close(beat - 1);
          continue;
        }

        if (!current) {
          current = {
            bodyId: body.id,
            windowIndex,
            startBeat: beat,
            endBeat: beat,
            beats: 1,
            eaveBeats: [],
            dayBeats: [],
          };
        }

        if (eaveAt(angle, win.centre, win.eave)) current.eaveBeats.push(beat);
        if (phaseAt(level, beat) === 'day') current.dayBeats.push(beat);
      }
      close(level.totalBeats - 1);
    }
  }

  return runs.sort((a, b) => a.startBeat - b.startBeat || a.bodyId.localeCompare(b.bodyId));
}

export function simulate(level: LevelDef, script: (Command | null)[] = []): SimulationResult {
  const commands: (Command | null)[] = Array.from({ length: level.totalBeats }, (_, beat) =>
    beat < script.length ? script[beat] : null,
  );
  const states: GameState[] = [createInitialState(level)];
  const reports: BeatReport[] = [];

  for (let beat = 0; beat < level.totalBeats; beat += 1) {
    const report = stepState(level, states[beat], commands[beat], beat);
    states.push(report.state);
    reports.push(report);
  }

  const runs = getVisibilityRuns(level);
  const finalState = states[states.length - 1];
  const audits: LossEvent[] = [];

  for (const body of level.bodies.filter((b) => b.designated)) {
    const hasRecord = finalState.records.some((r) => r.targetId === body.id);
    if (hasRecord) continue;
    for (const run of runs.filter((r) => r.bodyId === body.id)) {
      audits.push({
        id: `audit-${body.id}-${run.windowIndex}-${run.endBeat}`,
        beat: run.endBeat,
        targetId: body.id,
        code: 'window-miss',
        kind: 'window-miss',
        message: `${body.name}在${level.windows[run.windowIndex].name}的可见段于第 ${run.endBeat + 1} 拍结束，但没有交到合格记录。`,
      });
    }
  }

  const passed = level.bodies
    .filter((b) => b.designated)
    .every((b) => finalState.records.some((r) => r.targetId === b.id));

  return {
    level,
    commands,
    states,
    reports,
    runs,
    passed,
    records: finalState.records,
    losses: [...finalState.losses, ...audits],
  };
}

/** Simulate only the explicitly planned prefix; remaining beats are not evaluated. */
export function simulatePrefix(level: LevelDef, script: (Command | null)[]): SimulationResult {
  const prefixLevel: LevelDef = { ...level, totalBeats: script.length };
  return simulate(prefixLevel, script);
}
