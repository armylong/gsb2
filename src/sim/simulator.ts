import * as THREE from 'three';
import { GEOM_EPS, rayBox, rayTarget } from './geometry';
import type {
  BoxDef,
  Contact,
  EndReason,
  InteractionKind,
  ShotParams,
  ShotResult,
  TargetDef,
  TrajectorySegment,
} from './types';

/**
 * 瞬时直线弹道模拟器。
 *
 * 状态机要点:
 * - 每轮对全部物体重新做射线求交, 取 t 最小者 —— 命中次序由实际距离决定, 与创建次序无关。
 * - 射线贴合表面时, t < T_GATE 的接触被门限过滤, 反弹后不会连续命中同一处。
 * - 穿透按内部实际走过的长度 * 阻力扣费, 入口/出口属于同一次穿越, 只扣一次。
 * - 交互计数: entry、exit、reflect、blocked、target-hit 等各算 1 次, 上限 8。
 */

/** 表面贴合去抖门限 (世界单位)。小于该 t 的接触视为上一次交互的残留。 */
const T_GATE = 1e-5;
/** 反射后沿新方向前移的微小距离, 避免再次击中同一表面。 */
const NUDGE = 1e-5;

interface NearestHit {
  t: number;
  kind: 'box' | 'target';
  box?: BoxDef;
  boxHit?: ReturnType<typeof rayBox>;
  target?: TargetDef;
  targetHit?: ReturnType<typeof rayTarget>;
}

export const END_REASON_LABELS: Record<EndReason, string> = {
  'min-energy': '能量低于最低能量阈值, 发射前/飞行中终止',
  'max-range': '达到最大射程, 在射程终点结束 (无更多命中)',
  'max-interactions': '达到最多 8 次交互上限, 在最后一次交互点结束',
  blocked: '击中完全阻挡材料, 弹道终止于表面',
  'target-hit': '命中靶面 (前方无其他物体遮挡)',
  'reflect-rejected': '命中可反弹材料但入射角超限或反弹后能量不足, 停在表面',
  'exhausted-inside': '剩余能量不足以穿过材料, 停在材料内部',
};

export function directionFromYawPitch(yawDeg: number, pitchDeg: number): THREE.Vector3 {
  const yaw = THREE.MathUtils.degToRad(yawDeg);
  const pitch = THREE.MathUtils.degToRad(pitchDeg);
  return new THREE.Vector3(
    Math.cos(pitch) * Math.sin(yaw),
    Math.sin(pitch),
    Math.cos(pitch) * Math.cos(yaw),
  ).normalize();
}

function makeContact(
  kind: InteractionKind,
  objectId: string,
  objectName: string,
  point: THREE.Vector3,
  normal: THREE.Vector3 | null,
  incidenceDeg: number | null,
): Contact {
  return {
    kind,
    objectId,
    objectName,
    point: point.clone(),
    normal: normal ? normal.clone() : null,
    incidenceDeg,
  };
}

export function simulateShot(
  boxes: BoxDef[],
  targets: TargetDef[],
  params: ShotParams,
): ShotResult {
  const dir = params.direction.clone().normalize();
  let origin = params.origin.clone();
  let energy = params.initialEnergy;
  let remainingRange = params.maxRange;
  let interactionCount = 0;

  const segments: TrajectorySegment[] = [];
  const contacts: Contact[] = [];
  let endPoint = origin.clone();
  let segIndex = 0;

  const totalSoFar = () => segments.reduce((sum, s) => sum + s.length, 0);

  const pushFlight = (
    start: THREE.Vector3,
    end: THREE.Vector3,
    eBefore: number,
    eAfter: number,
    contact: Contact | null,
  ) => {
    segments.push({
      index: segIndex++,
      type: 'flight',
      start: start.clone(),
      end: end.clone(),
      length: start.distanceTo(end),
      energyBefore: eBefore,
      energyAfter: eAfter,
      materialObjectId: null,
      endContact: contact,
    });
  };

  const finish = (reason: EndReason): ShotResult => {
    const totalDistance = totalSoFar();
    return {
      params,
      segments,
      contacts,
      interactionCount,
      totalDistance,
      remainingEnergy: energy,
      endReason: reason,
      endPoint: endPoint.clone(),
    };
  };

  // 发射前能量检查
  if (params.initialEnergy < params.minEnergy - GEOM_EPS) {
    endPoint = origin.clone();
    return finish('min-energy');
  }
  if (params.maxRange <= GEOM_EPS) {
    endPoint = origin.clone();
    return finish('max-range');
  }

  // 最多交互上限的循环保护 (每轮至少产生一次交互, 否则走射程结束)
  for (let guard = 0; guard < params.maxInteractions + 2; guard++) {
    if (energy < params.minEnergy - GEOM_EPS) {
      endPoint = origin.clone();
      return finish('min-energy');
    }
    if (remainingRange <= GEOM_EPS) {
      endPoint = origin.clone();
      return finish('max-range');
    }

    // ---- 收集全部候选命中, 按实际 t 排序 ----
    const candidates: NearestHit[] = [];
    for (const box of boxes) {
      const hit = rayBox(origin, dir, box);
      if (!hit) continue;
      // 起点在该盒内部时, tEntry≈0 的入口是残留, 只保留出口 (tExit)
      const t = hit.originInside ? hit.tExit : hit.tEntry;
      if (t < T_GATE) continue;
      candidates.push({ t, kind: 'box', box, boxHit: hit });
    }
    for (const target of targets) {
      const hit = rayTarget(origin, dir, target);
      if (!hit || hit.t < T_GATE) continue;
      candidates.push({ t: hit.t, kind: 'target', target, targetHit: hit });
    }
    candidates.sort((a, b) => a.t - b.t);
    const nearest = candidates[0] ?? null;

    // ---- 无命中: 飞到射程终点 ----
    if (!nearest || nearest.t > remainingRange + GEOM_EPS) {
      const end = origin.clone().addScaledVector(dir, remainingRange);
      pushFlight(origin, end, energy, energy, null);
      origin = end;
      remainingRange = 0;
      endPoint = end;
      return finish('max-range');
    }

    const hit = nearest;

    // ---- 命中靶面: 能排到 nearest 说明前方无任何箱体遮挡 ----
    if (hit.kind === 'target') {
      const point = hit.targetHit!.point.clone();
      const contact = makeContact(
        'target-hit',
        hit.target!.id,
        hit.target!.name,
        point,
        hit.targetHit!.normal,
        null,
      );
      contacts.push(contact);
      interactionCount++;
      pushFlight(origin, point, energy, energy, contact);
      remainingRange -= origin.distanceTo(point);
      origin = point;
      endPoint = point;
      return finish('target-hit');
    }

    const hitBox = hit.box!;
    const boxHit = hit.boxHit!;
    // 起点已在该盒内部时, 交互发生在穿出的那一面 (出口), 否则在入口面
    const fromInside = boxHit.originInside;
    const surfacePoint = (fromInside ? boxHit.exitPoint : boxHit.entryPoint).clone();
    const surfaceNormal = (fromInside ? boxHit.exitNormal : boxHit.entryNormal).clone();

    // ---- 完全阻挡 ----
    if (hitBox.material.kind === 'blocking') {
      const contact = makeContact(
        'blocked',
        hitBox.id,
        hitBox.name,
        surfacePoint,
        surfaceNormal,
        null,
      );
      contacts.push(contact);
      interactionCount++;
      pushFlight(origin, surfacePoint, energy, energy, contact);
      remainingRange -= origin.distanceTo(surfacePoint);
      origin = surfacePoint;
      endPoint = surfacePoint;
      return finish('blocked');
    }

    // ---- 可反弹 ----
    if (hitBox.material.kind === 'reflective') {
      const n = surfaceNormal.normalize();
      // 入射角 (0° 为垂直命中):
      // 外部命中时取入射反方向 (-dir) 与外法线; 内部穿出时取前进方向 (dir) 与出口外法线
      const incidenceRef = fromInside ? dir.clone() : dir.clone().negate();
      const incidence = THREE.MathUtils.radToDeg(incidenceRef.angleTo(n));
      const energyAfterReflect = energy * (1 - hitBox.material.reflectLossRatio);
      const angleOk = incidence <= hitBox.material.maxReflectAngleDeg + GEOM_EPS;
      const energyOk = energyAfterReflect >= params.minEnergy - GEOM_EPS;

      if (!angleOk || !energyOk) {
        const contact = makeContact(
          'reflect-rejected',
          hitBox.id,
          hitBox.name,
          surfacePoint,
          n,
          incidence,
        );
        contacts.push(contact);
        interactionCount++;
        pushFlight(origin, surfacePoint, energy, energy, contact);
        origin = surfacePoint;
        endPoint = surfacePoint;
        return finish('reflect-rejected');
      }

      // r = d - 2(d·n)n
      const reflected = dir.clone().addScaledVector(n, -2 * dir.dot(n)).normalize();
      const contact = makeContact('reflect', hitBox.id, hitBox.name, surfacePoint, n, incidence);
      contacts.push(contact);
      interactionCount++;
      pushFlight(origin, surfacePoint, energy, energy, contact);
      // 零长度反射节点, 记录能量阶跃, 方便逐段检查
      segments.push({
        index: segIndex++,
        type: 'reflection',
        start: surfacePoint.clone(),
        end: surfacePoint.clone(),
        length: 0,
        energyBefore: energy,
        energyAfter: energyAfterReflect,
        materialObjectId: null,
        endContact: contact,
      });
      energy = energyAfterReflect;
      dir.copy(reflected);
      remainingRange -= origin.distanceTo(surfacePoint);
      origin = surfacePoint.clone().addScaledVector(dir, NUDGE);
      remainingRange -= NUDGE;
      endPoint = surfacePoint;

      if (interactionCount >= params.maxInteractions) {
        return finish('max-interactions');
      }
      continue;
    }

    // ---- 可穿透: 一次穿越只扣一次费, 费用按内部实际长度 ----
    const entryPoint = boxHit.entryPoint.clone();
    const exitPoint = boxHit.exitPoint.clone();
    const insideLength = entryPoint.distanceTo(exitPoint);
    const cost = insideLength * hitBox.material.resistance;
    const flightToEntry = origin.distanceTo(entryPoint);

    const entryContact = makeContact(
      'entry',
      hitBox.id,
      hitBox.name,
      entryPoint,
      boxHit.entryNormal,
      null,
    );
    contacts.push(entryContact);
    interactionCount++;
    pushFlight(origin, entryPoint, energy, energy, entryContact);
    remainingRange -= flightToEntry;
    origin = entryPoint;
    endPoint = entryPoint;

    if (interactionCount >= params.maxInteractions) {
      return finish('max-interactions');
    }

    // 能量不足以支付整段斜穿 (或剩余射程先耗尽): 停在内部对应位置
    const availableByEnergy =
      hitBox.material.resistance > GEOM_EPS ? energy / hitBox.material.resistance : Infinity;
    const stopDistance = Math.min(insideLength, availableByEnergy, remainingRange);

    if (stopDistance < insideLength - GEOM_EPS) {
      const stopPoint = entryPoint.clone().addScaledVector(dir, stopDistance);
      const usedEnergy = Math.min(energy, stopDistance * hitBox.material.resistance);
      segments.push({
        index: segIndex++,
        type: 'inside',
        start: entryPoint.clone(),
        end: stopPoint.clone(),
        length: stopDistance,
        energyBefore: energy,
        energyAfter: energy - usedEnergy,
        materialObjectId: hitBox.id,
        endContact: null,
      });
      energy = Math.max(0, energy - usedEnergy);
      remainingRange -= stopDistance;
      origin = stopPoint;
      endPoint = stopPoint;
      const stopContact = makeContact(
        'stop-inside',
        hitBox.id,
        hitBox.name,
        stopPoint,
        null,
        null,
      );
      contacts.push(stopContact);
      interactionCount++;
      return finish(
        remainingRange <= GEOM_EPS ? 'max-range' : 'exhausted-inside',
      );
    }

    // 完整穿过: 入口出口一次扣费, 不重复
    const exitContact = makeContact(
      'exit',
      hitBox.id,
      hitBox.name,
      exitPoint,
      boxHit.exitNormal,
      null,
    );
    contacts.push(exitContact);
    interactionCount++;
    segments.push({
      index: segIndex++,
      type: 'inside',
      start: entryPoint.clone(),
      end: exitPoint.clone(),
      length: insideLength,
      energyBefore: energy,
      energyAfter: energy - cost,
      materialObjectId: hitBox.id,
      endContact: exitContact,
    });
    energy = Math.max(0, energy - cost);
    remainingRange -= insideLength;
    origin = exitPoint.clone().addScaledVector(dir, NUDGE);
    remainingRange -= NUDGE;
    endPoint = exitPoint;

    if (interactionCount >= params.maxInteractions) {
      return finish('max-interactions');
    }
  }

  // 理论上不可达: 每轮都会在射程内终止或交互
  endPoint = origin.clone();
  return finish('max-range');
}
