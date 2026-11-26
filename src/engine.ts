import { pathCost, shortestPathCost } from './graph';
import type {
  ActorSnapshot,
  CueVerdict,
  Issue,
  Level,
  Plan,
  PlanAction,
  RoomUsage,
  SceneVerdict,
  SimulationResult,
  Snapshot,
  SlotId,
  GarmentSnapshot,
} from './types';

interface RuntimeGarment extends GarmentSnapshot {
  reservedBy: string | null;
}

interface ActiveAction {
  action: PlanAction;
  end: number;
}

interface RuntimeActor {
  id: string;
  location: Level['nodes'][number]['id'];
  worn: Record<SlotId, string | null>;
  current: ActiveAction | null;
  busySceneId: string | null;
  busyUntil: number;
  arrivalBeat: number;
}

interface CastInterval {
  sceneId: string;
  appearanceId: string;
  actorId: string;
  start: number;
  end: number;
}

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function simulate(level: Level, plan: Plan): SimulationResult {
  const violations: Issue[] = [];
  const seenIssues = new Set<string>();
  const statusById: Record<string, 'accepted' | 'rejected'> = {};

  const addIssue = (issue: Issue): void => {
    const key = [
      issue.code,
      issue.beat,
      issue.actorId ?? '',
      issue.sceneId ?? '',
      issue.appearanceId ?? '',
      issue.actionId ?? '',
      issue.message,
    ].join('|');
    if (seenIssues.has(key)) return;
    seenIssues.add(key);
    violations.push(issue);
  };

  const actorIds = new Set(level.actors.map((a) => a.id));
  const garmentIds = new Set(level.garments.map((g) => g.id));
  const nodeIds = new Set(level.nodes.map((n) => n.id));

  // ---- Runtime physical state -------------------------------------------
  const actors = new Map<string, RuntimeActor>();
  for (const def of level.actors) {
    actors.set(def.id, {
      id: def.id,
      location: def.start,
      worn: { base: null, outer: null },
      current: null,
      busySceneId: null,
      busyUntil: 0,
      arrivalBeat: 0,
    });
  }

  const garments = new Map<string, RuntimeGarment>();
  for (const def of level.garments) {
    let wornBy: string | null = null;
    let carriedBy: string | null = null;
    let location = def.initial.node ?? 'T';
    if (def.initial.type === 'wornBy' && def.initial.actor) {
      wornBy = def.initial.actor;
      const actor = actors.get(wornBy);
      location = actor?.location ?? level.actors[0]?.start ?? 'T';
      if (actor) actor.worn[def.slot] = def.id;
    }
    garments.set(def.id, { ...def, wornBy, carriedBy, location, reservedBy: null });
  }

  // ---- Casting and static interval conflicts -----------------------------
  const castIntervals: CastInterval[] = [];
  const cueVerdicts: CueVerdict[] = [];

  for (const scene of level.scenes) {
    for (const app of scene.appearances) {
      const actorId = plan.casting[app.id] ?? '';
      if (!actorId) {
        addIssue({
          code: 'uncast',
          beat: scene.start,
          severity: 'error',
          sceneId: scene.id,
          appearanceId: app.id,
          message: `「${app.role}」还没有分配演员`,
        });
        continue;
      }
      if (!actorIds.has(actorId)) {
        addIssue({
          code: 'bad-casting',
          beat: scene.start,
          severity: 'error',
          sceneId: scene.id,
          appearanceId: app.id,
          actorId,
          message: `分配给「${app.role}」的演员不存在`,
        });
        continue;
      }
      if (!app.candidateIds.includes(actorId)) {
        addIssue({
          code: 'casting-forbidden',
          beat: scene.start,
          severity: 'error',
          sceneId: scene.id,
          appearanceId: app.id,
          actorId,
          message: `该角色不在这位演员的可演范围内`,
        });
      }
      castIntervals.push({
        sceneId: scene.id,
        appearanceId: app.id,
        actorId,
        start: scene.start,
        end: scene.start + scene.duration,
      });
    }
  }

  for (let i = 0; i < castIntervals.length; i += 1) {
    for (let j = i + 1; j < castIntervals.length; j += 1) {
      const a = castIntervals[i];
      const b = castIntervals[j];
      if (a.actorId === b.actorId && overlap(a.start, a.end, b.start, b.end)) {
        addIssue({
          code: 'scene-overlap',
          beat: Math.max(a.start, b.start),
          severity: 'error',
          actorId: a.actorId,
          sceneId: b.sceneId,
          appearanceId: b.appearanceId,
          message: '同一演员被两幕重叠的演出时间占用，无法同时到场',
        });
      }
    }
  }

  // ---- Validate actions --------------------------------------------------
  const actions = [...plan.actions];
  const seenActionIds = new Set<string>();
  const actionsByStart = new Map<number, PlanAction[]>();

  for (const action of actions) {
    statusById[action.id] = 'accepted';
    if (seenActionIds.has(action.id)) {
      addIssue({
        code: 'duplicate-action',
        beat: action.start,
        severity: 'error',
        actionId: action.id,
        message: '存在重复的计划块 ID',
      });
    }
    seenActionIds.add(action.id);

    if (!actors.has(action.actorId)) {
      addIssue({
        code: 'unknown-actor',
        beat: action.start,
        severity: 'error',
        actionId: action.id,
        actorId: action.actorId,
        message: '计划块引用了不存在的演员',
      });
      statusById[action.id] = 'rejected';
      continue;
    }

    if (!Number.isInteger(action.start) || action.start < 0) {
      addIssue({
        code: 'bad-time',
        beat: Math.max(0, Math.floor(action.start) || 0),
        severity: 'error',
        actionId: action.id,
        actorId: action.actorId,
        message: '开始拍必须是不小于 0 的整数',
      });
      statusById[action.id] = 'rejected';
    }
    if (!Number.isInteger(action.duration) || action.duration <= 0) {
      addIssue({
        code: 'bad-duration',
        beat: action.start,
        severity: 'error',
        actionId: action.id,
        actorId: action.actorId,
        message: '动作时长必须是正整数拍',
      });
      statusById[action.id] = 'rejected';
    }
    if (action.start + action.duration > level.horizon) {
      addIssue({
        code: 'past-curfew',
        beat: action.start,
        severity: 'error',
        actionId: action.id,
        actorId: action.actorId,
        message: `动作在第 ${action.start + action.duration} 拍才结束，超过本场结算长度 ${level.horizon} 拍`,
      });
    }

    if (action.type === 'move') {
      const cost = pathCost(level, action.path);
      if (cost === null) {
        addIssue({
          code: 'bad-route',
          beat: action.start,
          severity: 'error',
          actionId: action.id,
          actorId: action.actorId,
          message: '路线里包含不存在的走道，不能这样走',
        });
        statusById[action.id] = 'rejected';
      } else if (cost !== action.duration) {
        addIssue({
          code: 'route-time-mismatch',
          beat: action.start,
          severity: 'error',
          actionId: action.id,
          actorId: action.actorId,
          message: `该路线需走 ${cost} 拍，但计划块填了 ${action.duration} 拍`,
        });
      }
      if (!nodeIds.has(action.path[0])) {
        addIssue({
          code: 'bad-route',
          beat: action.start,
          severity: 'error',
          actionId: action.id,
          message: '路线起点不存在',
        });
      }
    }

    if (action.type === 'change') {
      if (!garmentIds.has(action.garmentId)) {
        addIssue({
          code: 'unknown-garment',
          beat: action.start,
          severity: 'error',
          actionId: action.id,
          message: '换装计划引用了不存在的衣服',
        });
        statusById[action.id] = 'rejected';
      }
    }

    if (action.type === 'leave' || action.type === 'take') {
      const g = level.garments.find((item) => item.id === action.garmentId);
      if (!g) {
        addIssue({
          code: 'unknown-garment',
          beat: action.start,
          severity: 'error',
          actionId: action.id,
          message: '交接计划引用了不存在的衣服',
        });
        statusById[action.id] = 'rejected';
      } else if (action.type === 'leave' && !g.transferable) {
        addIssue({
          code: 'garment-not-transferable',
          beat: action.start,
          severity: 'error',
          actionId: action.id,
          actorId: action.actorId,
          message: `「${g.name}」是贴身戏服，不能放到中转台交给别人`,
        });
      }
    }

    if (statusById[action.id] !== 'rejected') {
      const list = actionsByStart.get(action.start) ?? [];
      list.push(action);
      actionsByStart.set(action.start, list);
    }
  }

  // Same actor cannot be in two planned blocks at once.
  for (let i = 0; i < actions.length; i += 1) {
    for (let j = i + 1; j < actions.length; j += 1) {
      const a = actions[i];
      const b = actions[j];
      if (a.actorId !== b.actorId) continue;
      if (overlap(a.start, a.start + a.duration, b.start, b.start + b.duration)) {
        addIssue({
          code: 'actor-overlap',
          beat: Math.max(a.start, b.start),
          severity: 'error',
          actorId: a.actorId,
          actionId: b.id,
          message: '同一演员的两个计划块时间重叠，一个人同一时刻只能在一个地方',
        });
        statusById[b.id] = 'rejected';
      }
    }
  }

  // Actions overlap mandatory scene intervals.
  for (const interval of castIntervals) {
    for (const action of actions) {
      if (action.actorId !== interval.actorId) continue;
      if (
        overlap(
          interval.start,
          interval.end,
          action.start,
          action.start + action.duration,
        )
      ) {
        addIssue({
          code: 'actor-scene-overlap',
          beat: Math.max(interval.start, action.start),
          severity: 'error',
          actorId: interval.actorId,
          sceneId: interval.sceneId,
          appearanceId: interval.appearanceId,
          actionId: action.id,
          message: '演出区间内安排了走路、换装或交接，演员无法同时完成',
        });
        if (statusById[action.id] === 'accepted') statusById[action.id] = 'rejected';
      }
    }
  }

  // Dressing rooms are exclusive.
  const changes = actions.filter((a): a is Extract<PlanAction, { type: 'change' }> => a.type === 'change');
  for (let i = 0; i < changes.length; i += 1) {
    for (let j = i + 1; j < changes.length; j += 1) {
      const a = changes[i];
      const b = changes[j];
      if (a.room === b.room && overlap(a.start, a.start + a.duration, b.start, b.start + b.duration)) {
        addIssue({
          code: 'room-busy',
          beat: Math.max(a.start, b.start),
          severity: 'error',
          actionId: b.id,
          actorId: b.actorId,
          message: `更衣间 ${a.room} 在同一时段被 ${a.actorId} 和 ${b.actorId} 重叠占用`,
        });
        if (statusById[b.id] === 'accepted') statusById[b.id] = 'rejected';
      }
    }
  }

  // Explicit garment blocks cannot be double-booked. Physical ownership is
  // also checked below because a worn garment remains busy after its block.
  const garmentBlocks = actions.filter(
    (a): a is Extract<PlanAction, { garmentId: string }> =>
      a.type === 'change' || a.type === 'leave' || a.type === 'take',
  );
  for (let i = 0; i < garmentBlocks.length; i += 1) {
    for (let j = i + 1; j < garmentBlocks.length; j += 1) {
      const a = garmentBlocks[i];
      const b = garmentBlocks[j];
      if (
        a.garmentId === b.garmentId &&
        overlap(a.start, a.start + a.duration, b.start, b.start + b.duration)
      ) {
        addIssue({
          code: 'garment-overlap',
          beat: Math.max(a.start, b.start),
          severity: 'error',
          actionId: b.id,
          actorId: b.actorId,
          message: '同一件衣服在重叠时间被两个换装/交接块占用',
        });
        if (statusById[b.id] === 'accepted') statusById[b.id] = 'rejected';
      }
    }
  }

  // ---- Simulation --------------------------------------------------------
  const snapshots: Snapshot[] = [];
  const sceneVerdicts: SceneVerdict[] = [];

  const completeAction = (actor: RuntimeActor, t: number): void => {
    const active = actor.current;
    if (!active) return;
    const action = active.action;

    if (action.type === 'move') {
      actor.location = action.path[action.path.length - 1];
      actor.arrivalBeat = t;
      for (const g of garments.values()) {
        if (g.carriedBy === actor.id) g.location = actor.location;
      }
    }

    if (action.type === 'change') {
      const g = garments.get(action.garmentId);
      if (!g) return;
      g.reservedBy = null;

      if (action.duration < g.don) {
        addIssue({
          code: 'costume-not-ready',
          beat: t,
          severity: 'error',
          actorId: actor.id,
          actionId: action.id,
          message: `「${g.name}」需要连续换 ${g.don} 拍，只给 ${action.duration} 拍，第 ${t} 拍仍未换好`,
        });
        actor.current = null;
        return;
      }

      if (!g.wearableBy.includes(actor.id)) {
        addIssue({
          code: 'garment-forbidden',
          beat: t,
          severity: 'error',
          actorId: actor.id,
          actionId: action.id,
          message: `这位演员不能穿「${g.name}」`,
        });
        actor.current = null;
        return;
      }

      const oldId = actor.worn[g.slot];
      if (oldId && oldId !== g.id) {
        const old = garments.get(oldId);
        if (old) {
          old.wornBy = null;
          old.carriedBy = actor.id;
          old.location = actor.location;
        }
      }
      g.wornBy = actor.id;
      g.carriedBy = null;
      g.location = action.room;
      actor.worn[g.slot] = g.id;
    }

    if (action.type === 'leave') {
      const g = garments.get(action.garmentId);
      if (g) {
        if (g.wornBy === actor.id && actor.worn[g.slot] === g.id) {
          actor.worn[g.slot] = null;
        }
        g.wornBy = null;
        g.carriedBy = null;
        g.location = 'T';
        g.reservedBy = null;
      }
    }

    if (action.type === 'take') {
      const g = garments.get(action.garmentId);
      if (g) {
        g.wornBy = null;
        g.carriedBy = actor.id;
        g.location = actor.location;
        g.reservedBy = null;
      }
    }

    actor.current = null;
  };

  const startAction = (action: PlanAction, t: number): void => {
    const actor = actors.get(action.actorId);
    if (!actor) {
      statusById[action.id] = 'rejected';
      return;
    }

    // Static overlap errors already explain the conflict. Keep physical state
    // consistent by rejecting the later block.
    if (statusById[action.id] === 'rejected') return;
    if (actor.current) {
      statusById[action.id] = 'rejected';
      return;
    }
    if (actor.busySceneId && actor.busyUntil > t) {
      statusById[action.id] = 'rejected';
      return;
    }

    if (action.type === 'move') {
      const cost = pathCost(level, action.path);
      let invalid = cost === null || cost !== action.duration;
      if (action.path[0] !== actor.location) {
        invalid = true;
        addIssue({
          code: 'location-gap',
          beat: t,
          severity: 'error',
          actorId: actor.id,
          actionId: action.id,
          message: `计划从 ${action.path[0]} 出发，但演员第 ${t} 拍实际在 ${actor.location}`,
        });
      }
      if (invalid) {
        statusById[action.id] = 'rejected';
        return;
      }
      statusById[action.id] = 'accepted';
      actor.current = { action, end: action.start + action.duration };
      return;
    }

    if (action.type === 'change') {
      const g = garments.get(action.garmentId);
      let invalid = false;
      if (actor.location !== action.room) {
        invalid = true;
        addIssue({
          code: 'wrong-room',
          beat: t,
          severity: 'error',
          actorId: actor.id,
          actionId: action.id,
          message: `换装块排在 ${action.room} 间，但演员第 ${t} 拍在 ${actor.location}；不能在路上换衣服`,
        });
      }

      const occupant = [...actors.values()].find(
        (other) =>
          other.id !== actor.id &&
          other.current?.action.type === 'change' &&
          other.current.action.room === action.room &&
          other.current.end > t,
      );
      if (occupant) {
        invalid = true;
        addIssue({
          code: 'room-busy',
          beat: t,
          severity: 'error',
          actorId: actor.id,
          actionId: action.id,
          message: `更衣间 ${action.room} 正被 ${occupant.id} 占用`,
        });
      }

      if (!g) {
        invalid = true;
      } else {
        if (!g.wearableBy.includes(actor.id)) {
          invalid = true;
          addIssue({
            code: 'garment-forbidden',
            beat: t,
            severity: 'error',
            actorId: actor.id,
            actionId: action.id,
            message: `「${g.name}」不在这位演员可穿的衣服清单里`,
          });
        }
        if (g.reservedBy) {
          invalid = true;
          addIssue({
            code: 'garment-busy',
            beat: t,
            severity: 'error',
            actorId: actor.id,
            actionId: action.id,
            message: `「${g.name}」正被另一个交接/换装块预留`,
          });
        } else if (g.wornBy && g.wornBy !== actor.id) {
          invalid = true;
          addIssue({
            code: 'garment-worn',
            beat: t,
            severity: 'error',
            actorId: actor.id,
            actionId: action.id,
            message: `「${g.name}」此刻还穿在 ${g.wornBy} 身上，不能同时分给下一幕的人`,
          });
        } else if (g.carriedBy && g.carriedBy !== actor.id) {
          invalid = true;
          addIssue({
            code: 'garment-carried',
            beat: t,
            severity: 'error',
            actorId: actor.id,
            actionId: action.id,
            message: `「${g.name}」正由 ${g.carriedBy} 携带，尚未交到手上`,
          });
        } else if (!g.wornBy && !g.carriedBy && g.location !== action.room) {
          invalid = true;
          addIssue({
            code: 'garment-location',
            beat: t,
            severity: 'error',
            actorId: actor.id,
            actionId: action.id,
            message: `「${g.name}」现在在 ${g.location}，不在更衣间 ${action.room}`,
          });
        }
      }

      if (invalid || !g) {
        statusById[action.id] = 'rejected';
        return;
      }
      g.reservedBy = action.id;
      statusById[action.id] = 'accepted';
      actor.current = { action, end: action.start + action.duration };
      return;
    }

    // leave / take
    const g = garments.get(action.garmentId);
    let invalid = false;
    if (actor.location !== 'T') {
      invalid = true;
      addIssue({
        code: 'wrong-station',
        beat: t,
        severity: 'error',
        actorId: actor.id,
        actionId: action.id,
        message: `交接动作必须在中转台 T，但演员第 ${t} 拍在 ${actor.location}`,
      });
    }
    if (!g) {
      invalid = true;
    } else if (g.reservedBy) {
      invalid = true;
      addIssue({
        code: 'garment-busy',
        beat: t,
        severity: 'error',
        actionId: action.id,
        message: `「${g.name}」正被另一个动作预留`,
      });
    } else if (action.type === 'leave') {
      const heldByActor = g.wornBy === actor.id || g.carriedBy === actor.id;
      if (!heldByActor) {
        invalid = true;
        addIssue({
          code: 'garment-not-held',
          beat: t,
          severity: 'error',
          actorId: actor.id,
          actionId: action.id,
          message: `要留在中转台的「${g.name}」不在这位演员身上`,
        });
      }
    } else if (action.type === 'take') {
      if (g.wornBy || g.carriedBy || g.location !== 'T') {
        invalid = true;
        addIssue({
          code: 'garment-not-at-relay',
          beat: t,
          severity: 'error',
          actorId: actor.id,
          actionId: action.id,
          message: `「${g.name}」还没放到中转台，不能提前取走`,
        });
      }
    }

    if (invalid || !g) {
      statusById[action.id] = 'rejected';
      return;
    }
    g.reservedBy = action.id;
    statusById[action.id] = 'accepted';
    actor.current = { action, end: action.start + action.duration };
  };

  for (let t = 0; t <= level.horizon; t += 1) {
    // 1. Blocks ending on this beat complete first. An arrival at beat t is
    //    valid for a cue starting at t.
    for (const actor of actors.values()) {
      if (actor.current?.end === t) completeAction(actor, t);
    }

    // 2. Scenes ending at t release the actor exactly at this boundary.
    for (const actor of actors.values()) {
      if (actor.busySceneId && actor.busyUntil <= t) {
        actor.busySceneId = null;
      }
    }

    // 3. Entrance queue at the call boundary, before new blocks/scenes start.
    const queues: Record<'L' | 'R', string[]> = { L: [], R: [] };
    for (const def of level.actors) {
      const actor = actors.get(def.id)!;
      if (
        (actor.location === 'L' || actor.location === 'R') &&
        !actor.current &&
        !actor.busySceneId
      ) {
        queues[actor.location].push(actor.id);
      }
    }
    for (const key of ['L', 'R'] as const) {
      queues[key].sort((a, b) => {
        const aa = actors.get(a)!;
        const bb = actors.get(b)!;
        return aa.arrivalBeat - bb.arrivalBeat || a.localeCompare(b);
      });
    }

    // 4. Settle every scene whose call is this beat.
    for (const scene of level.scenes) {
      if (scene.start !== t) continue;
      const cueResults: CueVerdict[] = [];

      for (const app of scene.appearances) {
        const actorId = plan.casting[app.id] ?? null;
        const base = {
          sceneId: scene.id,
          appearanceId: app.id,
          actorId,
          title: scene.title,
          role: app.role,
          entrance: scene.entrance,
        };

        if (!actorId || !actorIds.has(actorId)) {
          const issue: Issue = {
            code: 'uncast',
            beat: t,
            severity: 'error',
            sceneId: scene.id,
            appearanceId: app.id,
            message: `「${app.role}」没有有效演员，无法到场`,
          };
          addIssue(issue);
          cueResults.push({ ...base, ok: false, status: 'uncast', issues: [issue] });
          continue;
        }

        const actor = actors.get(actorId)!;
        const issues: Issue[] = [];
        const opposite = scene.entrance === 'L' ? 'R' : 'L';
        let etaBeat: number | undefined;
        let present = false;

        const activeCueAction = actor.current;
        if (activeCueAction?.action.type === 'move' && activeCueAction.end > t) {
          const move = activeCueAction.action;
          const destination = move.path[move.path.length - 1];
          const extra = shortestPathCost(level, destination, scene.entrance) ?? 99;
          etaBeat = activeCueAction.end + extra;
          issues.push({
            code: 'late',
            beat: t,
            severity: 'error',
            actorId,
            sceneId: scene.id,
            appearanceId: app.id,
            actionId: move.id,
            message: `第 ${t} 拍仍在路上，预计第 ${etaBeat} 拍才能到 ${scene.entrance} 口，赶不上开演`,
          });
        } else if (actor.current) {
          const end = actor.current.end;
          const extra = shortestPathCost(level, actor.location, scene.entrance) ?? 99;
          etaBeat = end + extra;
          issues.push({
            code: 'late',
            beat: t,
            severity: 'error',
            actorId,
            sceneId: scene.id,
            appearanceId: app.id,
            actionId: actor.current.action.id,
            message: `第 ${t} 拍还在执行「${actor.current.action.type}」，最早约第 ${etaBeat} 拍到入口`,
          });
        } else {
          etaBeat = t + (shortestPathCost(level, actor.location, scene.entrance) ?? 99);
          if (actor.location === scene.entrance) {
            present = true;
          } else if (actor.location === opposite) {
            issues.push({
              code: 'wrong-door',
              beat: t,
              severity: 'error',
              actorId,
              sceneId: scene.id,
              appearanceId: app.id,
              message: `人到了 ${opposite} 口，但这一幕要求从 ${scene.entrance} 口上场`,
            });
          } else {
            issues.push({
              code: 'late',
              beat: t,
              severity: 'error',
              actorId,
              sceneId: scene.id,
              appearanceId: app.id,
              message: `第 ${t} 拍在 ${actor.location}，走到 ${scene.entrance} 口还需时间，预计第 ${etaBeat} 拍`,
            });
          }
        }

        for (const [slot, requiredGarmentId] of Object.entries(app.requires) as [SlotId, string][]) {
          const wornId = actor.worn[slot];
          if (wornId !== requiredGarmentId) {
            const required = garments.get(requiredGarmentId);
            const actual = wornId ? garments.get(wornId)?.name ?? wornId : '便服/未穿对应件';
            issues.push({
              code: 'costume-mismatch',
              beat: t,
              severity: 'error',
              actorId,
              sceneId: scene.id,
              appearanceId: app.id,
              message: `衣服没换好：「${app.role}」需要「${required?.name ?? requiredGarmentId}」，当前是${actual}`,
            });
          }
        }

        if (actor.busySceneId && actor.busyUntil > t) {
          issues.push({
            code: 'conflict',
            beat: t,
            severity: 'error',
            actorId,
            sceneId: scene.id,
            appearanceId: app.id,
            message: `演员仍被另一幕 ${actor.busySceneId} 占用`,
          });
        }

        for (const issue of issues) addIssue(issue);

        let status: CueVerdict['status'] = 'ok';
        if (issues.some((i) => i.code === 'conflict')) status = 'conflict';
        else if (issues.some((i) => i.code === 'wrong-door')) status = 'wrong-door';
        else if (issues.some((i) => i.code === 'late')) status = 'late';
        else if (issues.some((i) => i.code === 'costume-mismatch')) status = 'costume';

        const ok = issues.length === 0;
        const verdict: CueVerdict = {
          ...base,
          ok,
          status: ok ? 'ok' : status,
          issues,
          etaBeat,
          arrivalBeat: present ? t : undefined,
        };
        cueResults.push(verdict);
        cueVerdicts.push(verdict);
      }

      const sceneVerdict: SceneVerdict = {
        sceneId: scene.id,
        title: scene.title,
        start: scene.start,
        entrance: scene.entrance,
        ok: cueResults.every((cue) => cue.ok),
        cues: cueResults,
      };
      sceneVerdicts.push(sceneVerdict);

      // Cancel blocks that run through the call; static check already flagged.
      for (const cue of cueResults) {
        if (!cue.actorId) continue;
        const actor = actors.get(cue.actorId);
        if (actor?.current && actor.current.end > t) {
          statusById[actor.current.action.id] = 'rejected';
          actor.current = null;
        }
      }

      // The assigned cast is physically bound to the scene interval for
      // planning purposes, even when the cue fails.
      for (const app of scene.appearances) {
        const actorId = plan.casting[app.id];
        const actor = actorId ? actors.get(actorId) : undefined;
        if (!actor) continue;
        const end = scene.start + scene.duration;
        if (actor.busySceneId && actor.busyUntil > t && actor.busySceneId !== scene.id) {
          addIssue({
            code: 'scene-overlap',
            beat: t,
            severity: 'error',
            actorId: actor.id,
            sceneId: scene.id,
            appearanceId: app.id,
            message: '两幕演出时间重叠，演员无法同时在台上',
          });
        } else {
          actor.busySceneId = scene.id;
          actor.busyUntil = end;
        }
      }
    }

    // 5. Start blocks planned at this beat.
    for (const action of actionsByStart.get(t) ?? []) {
      startAction(action, t);
    }

    // 6. Immutable-ish snapshot for inspector/canvas.
    const actorSnapshots: ActorSnapshot[] = level.actors.map((def) => {
      const actor = actors.get(def.id)!;
      let transit: ActorSnapshot['transit'] = null;
      if (actor.current?.action.type === 'move') {
        const move = actor.current.action;
        transit = {
          path: move.path,
          elapsed: Math.max(0, Math.min(move.duration, t - move.start)),
          duration: move.duration,
        };
      }
      const carried = [...garments.values()]
        .filter((g) => g.carriedBy === def.id)
        .map((g) => g.id);
      return {
        id: def.id,
        location: actor.location,
        transit,
        worn: { ...actor.worn },
        carried,
        currentActionId: actor.current?.action.id ?? null,
        busySceneId: actor.busySceneId,
        arrivalBeat: actor.arrivalBeat,
      };
    });

    const garmentSnapshots: GarmentSnapshot[] = [...garments.values()].map(
      ({ reservedBy: _reservedBy, ...g }) => ({ ...g }),
    );

    const roomUsage: RoomUsage[] = changes
      .filter((action) => action.start <= t && t < action.start + action.duration)
      .map((action) => ({
        room: action.room,
        actionId: action.id,
        actorId: action.actorId,
        start: action.start,
        end: action.start + action.duration,
        accepted: statusById[action.id] !== 'rejected',
        label: garments.get(action.garmentId)?.name ?? action.garmentId,
      }));

    snapshots.push({
      beat: t,
      queues: { L: [...queues.L], R: [...queues.R] },
      actors: actorSnapshots,
      garments: garmentSnapshots,
      roomUsage,
    });
  }

  const firstErrorBeat = violations.length
    ? violations.reduce((min, issue) => Math.min(min, issue.beat), level.horizon + 1)
    : null;

  return {
    levelId: level.id,
    horizon: level.horizon,
    snapshots,
    violations,
    sceneVerdicts,
    cueVerdicts,
    statusById,
    passed: violations.length === 0 && cueVerdicts.every((cue) => cue.ok),
    firstErrorBeat,
  };
}
