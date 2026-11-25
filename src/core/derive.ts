import {
  CATCHUP_DEADLINE_SEC,
  CATCHUP_RATE,
  NEARBY_LIMIT_SEC,
  OFFLINE_CONFIRM_SEC,
  RECOVERY_STABLE_SEC,
  SIM_STEP_SEC,
  STALL_CONFIRM_SEC,
  SWITCH_HOLD_SEC,
  SYNC_TOLERANCE_SEC,
} from './config';
import { REASON_LABEL, REASON_RULE } from './labels';
import type {
  Cue,
  LockMode,
  RouteId,
  SimState,
  SourceState,
  SwitchReason,
  SwitchRecord,
} from './types';

const EPS = 1e-7;

interface DeriveOptions {
  cues: Cue[];
  duration: number;
  time: number;
  scenarioId?: SimState['scenarioId'];
}

function makeSource(id: RouteId, name: string, role: SourceState['role']): SourceState {
  return {
    id,
    name,
    role,
    health: 'ok',
    pts: 0,
    lastGoodPts: 0,
    rate: 1,
    gapSec: 0,
    // The generated clips start frame-aligned and ready.
    stableSec: RECOVERY_STABLE_SEC,
    badSince: null,
    confirmedBad: false,
    catchUp: null,
    lastAlignment: null,
    seekNonce: 0,
  };
}

function startupSwitch(): SwitchRecord {
  return {
    id: 'sw-1',
    at: 0,
    from: null,
    to: 'A',
    reason: 'startup',
    title: REASON_LABEL.startup,
    rule: REASON_RULE.startup,
    targetPts: 0,
    fromPts: 0,
    toPtsBefore: 0,
    deltaBeforeMs: 0,
    deltaAfterMs: 0,
    nearby: true,
  };
}

function createState(duration: number, scenarioId: SimState['scenarioId']): SimState {
  return {
    duration,
    time: 0,
    lock: 'auto',
    scenarioId,
    sources: {
      A: makeSource('A', 'PROGRAM A', '主路'),
      B: makeSource('B', 'BACKUP B', '备路'),
    },
    output: 'A',
    lastOutput: 'A',
    programState: 'live',
    switches: [startupSwitch()],
  };
}

function hardSeek(
  source: SourceState,
  at: number,
  targetPts: number,
  reason: string,
): void {
  const fromPts = source.pts;
  const deltaMs = (fromPts - targetPts) * 1000;
  source.pts = targetPts;
  source.gapSec = targetPts - at;
  if (source.health === 'ok') source.lastGoodPts = targetPts;
  source.rate = 1;
  source.stableSec = 0;
  source.seekNonce += 1;
  source.lastAlignment = { at, fromPts, toPts: targetPts, deltaMs, reason };
  source.catchUp = {
    active: false,
    mode: 'seek',
    fromPts,
    targetPts,
    initialGapMs: deltaMs,
    rate: 1,
    startedAt: at,
    deadlineSec: CATCHUP_DEADLINE_SEC,
    estimatedSec: 0,
    impossible: false,
    late: false,
    deadlineMissed: false,
    completedAt: at,
  };
}

function startCatchUp(source: SourceState, at: number, masterTime: number): void {
  const gapSec = source.pts - masterTime;
  source.gapSec = gapSec;
  const behindSec = Math.max(0, -gapSec);
  const estimatedSec = behindSec / (CATCHUP_RATE - 1);
  const aligned = Math.abs(gapSec) <= SYNC_TOLERANCE_SEC;

  if (aligned) {
    source.pts = masterTime;
    source.gapSec = 0;
    source.rate = 1;
    source.catchUp = {
      active: false,
      mode: 'ff',
      fromPts: source.pts,
      targetPts: masterTime,
      initialGapMs: 0,
      rate: 1,
      startedAt: at,
      deadlineSec: CATCHUP_DEADLINE_SEC,
      estimatedSec: 0,
      impossible: false,
      late: false,
      deadlineMissed: false,
      completedAt: at,
    };
    return;
  }

  source.rate = CATCHUP_RATE;
  source.stableSec = 0;
  source.catchUp = {
    active: true,
    mode: 'ff',
    fromPts: source.pts,
    targetPts: masterTime,
    initialGapMs: gapSec * 1000,
    rate: CATCHUP_RATE,
    startedAt: at,
    deadlineSec: CATCHUP_DEADLINE_SEC,
    estimatedSec,
    impossible: estimatedSec > CATCHUP_DEADLINE_SEC || gapSec > SYNC_TOLERANCE_SEC,
    late: false,
    deadlineMissed: estimatedSec > CATCHUP_DEADLINE_SEC,
  };
}

function advanceSource(source: SourceState, dt: number, time: number): void {
  if (source.health !== 'ok') {
    source.rate = 0;
    source.gapSec = source.pts - time;
    source.stableSec = 0;
    if (source.badSince !== null) {
      const wait =
        source.health === 'offline' ? OFFLINE_CONFIRM_SEC : STALL_CONFIRM_SEC;
      source.confirmedBad = time - source.badSince >= wait - EPS;
    }
    return;
  }

  source.confirmedBad = false;

  const catchUp = source.catchUp;
  if (catchUp?.active && catchUp.mode !== 'seek') {
    source.rate = CATCHUP_RATE;
    source.pts += dt * CATCHUP_RATE;
    catchUp.targetPts = time;

    const gap = source.pts - time;
    const elapsed = time - catchUp.startedAt;
    if (Math.abs(gap) <= SYNC_TOLERANCE_SEC) {
      source.pts = time;
      catchUp.deadlineMissed =
        catchUp.deadlineMissed ||
        catchUp.impossible ||
        catchUp.late ||
        time - catchUp.startedAt >= catchUp.deadlineSec - EPS;
      catchUp.active = false;
      catchUp.late = false;
      catchUp.completedAt = time;
      source.rate = 1;
    } else if (elapsed >= CATCHUP_DEADLINE_SEC) {
      catchUp.late = true;
    }
  } else {
    source.rate = 1;
    source.pts += dt;
  }

  source.gapSec = source.pts - time;
  if (!source.catchUp?.active && Math.abs(source.gapSec) <= SYNC_TOLERANCE_SEC) {
    source.stableSec += dt;
  } else {
    source.stableSec = 0;
  }
  source.lastGoodPts = source.pts;
}

function isDead(source: SourceState): boolean {
  return source.health !== 'ok' && source.confirmedBad;
}

function isEligible(source: SourceState): boolean {
  return (
    source.health === 'ok' &&
    !source.catchUp?.active &&
    Math.abs(source.gapSec) <= SYNC_TOLERANCE_SEC &&
    source.stableSec >= RECOVERY_STABLE_SEC - EPS
  );
}

function chooseEmergencyCandidate(state: SimState): RouteId | null {
  const candidates = (['A', 'B'] as RouteId[])
    .map(id => state.sources[id])
    .filter(source => source.health === 'ok')
    .sort((a, b) => {
      if (isEligible(a) !== isEligible(b)) return isEligible(a) ? -1 : 1;
      const syncDiff = Math.abs(a.gapSec) - Math.abs(b.gapSec);
      if (Math.abs(syncDiff) > EPS) return syncDiff;
      // Explicit fixed priority tie-break.
      return a.id === 'A' ? -1 : 1;
    });
  return candidates[0]?.id ?? null;
}

interface SwitchOptions {
  targetPts?: number;
  simultaneousRecovery?: boolean;
}

function performSwitch(
  state: SimState,
  to: RouteId | null,
  reason: SwitchReason,
  options: SwitchOptions = {},
): void {
  const from = state.output;
  if (from === to) return;

  const record: SwitchRecord = {
    id: `sw-${state.switches.length + 1}`,
    at: state.time,
    from,
    to,
    reason,
    title: REASON_LABEL[reason],
    rule: REASON_RULE[reason],
    simultaneousRecovery: options.simultaneousRecovery,
  };

  if (to) {
    const target =
      options.targetPts ??
      (from ? state.sources[from].lastGoodPts : state.time);
    const targetSource = state.sources[to];
    const beforePts = targetSource.pts;

    record.targetPts = target;
    record.fromPts = from ? state.sources[from].lastGoodPts : undefined;
    record.toPtsBefore = beforePts;
    record.deltaBeforeMs = (beforePts - target) * 1000;
    record.nearby = Math.abs(beforePts - target) <= NEARBY_LIMIT_SEC + EPS;

    if (Math.abs(beforePts - target) > SYNC_TOLERANCE_SEC) {
      hardSeek(targetSource, state.time, target, `切换到 ${to}：${REASON_LABEL[reason]}`);
    }
    record.deltaAfterMs = (targetSource.pts - target) * 1000;

    // The switch target can be the dead route's last good PTS, slightly behind
    // the broadcast timeline. Catch back up at high speed instead of staying
    // permanently offset.
    if (Math.abs(state.time - target) > SYNC_TOLERANCE_SEC) {
      startCatchUp(targetSource, state.time, state.time);
    }
  } else if (from) {
    record.fromPts = state.sources[from].lastGoodPts;
  }

  state.switches.push(record);
  state.output = to;
  if (to) state.lastOutput = to;
  else if (from) state.lastOutput = from;
}

function elect(state: SimState, batch: Cue[] = []): void {
  const unlockCue = [...batch].reverse().find(cue => cue.kind === 'lock' && cue.lock === 'auto');
  const recoveredRoutes = new Set(
    batch
      .filter(cue => cue.kind === 'health' && cue.health === 'ok')
      .map(cue => (cue as Extract<Cue, { kind: 'health' }>).route),
  );
  const simultaneousRecovery = recoveredRoutes.size >= 2;

  if (state.lock !== 'auto') {
    if (state.output !== state.lock) {
      performSwitch(state, state.lock, 'manual-lock');
    }
    return;
  }

  const current = state.output;
  const lastSwitch = state.switches[state.switches.length - 1];
  const sinceSwitch = state.time - lastSwitch.at;

  if (current) {
    const currentSource = state.sources[current];

    if (!isDead(currentSource)) {
      // Hysteresis / switch-back policy. A healthy current route is not moved
      // until the preferred primary has remained stable for the full window.
      if (
        current === 'B' &&
        sinceSwitch >= SWITCH_HOLD_SEC - EPS &&
        isEligible(state.sources.A)
      ) {
        performSwitch(state, 'A', unlockCue ? 'lock-released' : 'recovery-primary');
      } else if (unlockCue && isEligible(state.sources.A) && current === 'B') {
        performSwitch(state, 'A', 'lock-released');
      }
      return;
    }

    const candidate = chooseEmergencyCandidate(state);
    if (candidate) {
      const reason: SwitchReason = unlockCue
        ? 'lock-released'
        : current === 'A'
          ? 'primary-unavailable'
          : 'route-unavailable';
      performSwitch(state, candidate, reason, {
        targetPts: currentSource.lastGoodPts,
      });
    } else {
      performSwitch(state, null, 'both-unavailable');
    }
    return;
  }

  const candidate = chooseEmergencyCandidate(state);
  if (!candidate) return;

  const reason: SwitchReason = unlockCue
    ? 'lock-released'
    : simultaneousRecovery
      ? 'both-recovered-election'
      : 'signal-restored';
  performSwitch(state, candidate, reason, {
    targetPts: state.time,
    simultaneousRecovery,
  });
}

function applyCue(state: SimState, cue: Cue): void {
  switch (cue.kind) {
    case 'health': {
      const source = state.sources[cue.route];
      source.health = cue.health;
      if (cue.health === 'ok') {
        source.badSince = null;
        source.confirmedBad = false;
        if (cue.recovery === 'seek') {
          hardSeek(source, cue.at, state.time, cue.label ?? '恢复并跳转对齐');
        } else {
          startCatchUp(source, cue.at, state.time);
        }
      } else {
        source.badSince = cue.at;
        source.confirmedBad = false;
        source.rate = 0;
        source.catchUp = null;
      }
      break;
    }
    case 'lock':
      state.lock = cue.lock as LockMode;
      break;
    case 'align':
      hardSeek(state.sources[cue.route], cue.at, state.time, cue.label ?? '手动对齐');
      break;
    case 'catchup':
      startCatchUp(state.sources[cue.route], cue.at, state.time);
      break;
  }
}

function deriveProgramState(state: SimState): void {
  if (state.lock !== 'auto') {
    state.programState = state.sources[state.lock].health === 'ok' ? 'live' : 'locked-bad';
    return;
  }
  if (!state.output) {
    state.programState = 'no-source';
    return;
  }
  const source = state.sources[state.output];
  state.programState = source.health === 'ok' ? 'live' : 'confirming';
}

export function deriveState(options: DeriveOptions): SimState {
  const targetTime = Math.max(0, Math.min(options.duration, options.time));
  const state = createState(options.duration, options.scenarioId ?? 'manual');
  const cues = [...options.cues].sort((a, b) => a.at - b.at);
  let index = 0;

  const applyDueCues = (): Cue[] => {
    const batch: Cue[] = [];
    while (index < cues.length && cues[index].at <= state.time + EPS) {
      const cue = cues[index];
      index += 1;
      batch.push(cue);
      applyCue(state, cue);
    }
    if (batch.length) elect(state, batch);
    return batch;
  };

  applyDueCues();

  let guard = 0;
  while (state.time < targetTime - EPS && guard < 100000) {
    guard += 1;
    let dt = Math.min(SIM_STEP_SEC, targetTime - state.time);
    const nextCue = cues[index];

    if (nextCue && nextCue.at > state.time + EPS) {
      dt = Math.min(dt, nextCue.at - state.time);
    }

    if (dt <= EPS) {
      applyDueCues();
      if (index < cues.length && cues[index].at <= state.time + EPS) continue;
      break;
    }

    state.time += dt;
    for (const source of Object.values(state.sources)) {
      advanceSource(source, dt, state.time);
    }
    elect(state);
    applyDueCues();
  }

  state.time = targetTime;
  for (const source of Object.values(state.sources)) {
    source.gapSec = source.pts - state.time;
  }
  deriveProgramState(state);
  return state;
}
