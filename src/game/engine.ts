import { armTarget, eye } from './layout';
import { firstBlocker } from './obstacles';
import {
  FRAME_LEN,
  SLOT_ROLES,
  SYMBOL_MAP,
  symbolFromDirs,
  valueFitsRole,
  verifyFrame,
} from './symbols';
import type {
  BoardMessage,
  BoardSlot,
  Claim,
  Cue,
  Dir,
  ForwardManifest,
  Observation,
  Policy,
  StationId,
} from './types';

export const STATION_IDS: StationId[] = ['north', 'west', 'east'];

// ---------------- 单拍观测 ----------------

export function observeCue(cue: Cue, observer: StationId): Observation {
  const sym = SYMBOL_MAP[cue.symbolId];
  const arms = [0, 1].map((arm) => {
    const a = arm as 0 | 1;
    const trueDir = sym.pair[a];
    const halves = ([0, 1] as const).map((h) => {
      const poses = cue.layouts[h];
      const target = armTarget(cue.sender, trueDir);
      const blocked = firstBlocker(eye(observer), target, poses);
      let recordedDir: Dir | null = null;
      let misread = false;
      if (!blocked) {
        const m = cue.misreads?.find((mm) => mm.observer === observer && mm.arm === a);
        if (m) {
          recordedDir = m.recordedDir;
          misread = true;
        } else {
          recordedDir = trueDir;
        }
      }
      return {
        seen: !blocked,
        recordedDir,
        blockedBy: blocked,
        misread,
      };
    });
    return { arm: a, trueDir, halves: [halves[0], halves[1]] as const };
  }) as Observation['arms'];

  const armSeen = arms.map((a) => a.halves.some((h) => h.seen));
  let simultaneousHalf: 0 | 1 | null = null;
  for (const h of [0, 1] as const) {
    if (arms[0].halves[h].seen && arms[1].halves[h].seen) {
      simultaneousHalf = h;
      break;
    }
  }

  let level: Observation['level'];
  if (armSeen[0] && armSeen[1]) {
    level = simultaneousHalf !== null ? 'both' : 'stitch';
  } else if (armSeen[0] || armSeen[1]) {
    level = 'one';
  } else {
    level = 'none';
  }

  // 宽松：每面旗只要在任意半拍被看见，就用其记录方向；允许跨半拍拼合
  let lenientValue: string | null = null;
  let lenientIssue: string | undefined;
  const lenientDirs: (Dir | null)[] = [null, null];
  for (const a of [0, 1] as const) {
    const dirs = new Set(
      arms[a].halves.filter((h) => h.recordedDir !== null).map((h) => h.recordedDir as Dir),
    );
    if (dirs.size === 0) {
      lenientIssue = `第${a === 0 ? '朱' : '青'}旗全程未见`;
    } else if (dirs.size > 1) {
      lenientIssue = `第${a === 0 ? '朱' : '青'}旗两半拍判读不一致`;
    } else {
      lenientDirs[a] = [...dirs][0];
    }
  }
  if (!lenientIssue && lenientDirs[0] !== null && lenientDirs[1] !== null) {
    const id = symbolFromDirs(lenientDirs[0], lenientDirs[1]);
    if (id) lenientValue = id;
    else lenientIssue = '拼出的旗位组合不在字母表';
  }

  // 严格：只采信两面同时清楚的半拍，绝不跨半拍拼
  let strictValue: string | null = null;
  let strictIssue: string | undefined;
  if (simultaneousHalf === null) {
    strictIssue = '没有任何半拍两面同清，严格规则不跨半拍拼合';
  } else {
    const h = simultaneousHalf;
    const d0 = arms[0].halves[h].recordedDir;
    const d1 = arms[1].halves[h].recordedDir;
    if (d0 !== null && d1 !== null) {
      const id = symbolFromDirs(d0, d1);
      if (id) strictValue = id;
      else strictIssue = '该半拍旗位组合不在字母表';
    } else {
      strictIssue = '同清半拍缺少旗位记录';
    }
  }

  return {
    cueId: cue.id,
    stepIndex: cue.stepIndex,
    beatIndex: cue.beatIndex,
    txId: cue.txId,
    observer,
    sender: cue.sender,
    arms,
    level,
    simultaneousHalf,
    lenientValue,
    strictValue,
    lenientIssue,
    strictIssue,
  };
}

export function observationKey(cueId: string, observer: StationId): string {
  return `${cueId}::${observer}`;
}

export function buildObservationMap(
  cues: Cue[],
  cursor: number,
): Map<string, Observation> {
  const map = new Map<string, Observation>();
  for (const cue of cues.slice(0, cursor)) {
    for (const observer of STATION_IDS) {
      if (observer === cue.sender) continue;
      map.set(observationKey(cue.id, observer), observeCue(cue, observer));
    }
  }
  return map;
}

// ---------------- 拍帧扫描 ----------------

/**
 * 固定七拍帧：启 + 4 数据 + 核 + 止。
 * 只认真正判成「启」的拍作为锚点，窗口长度绝不伸缩，
 * 因此窗口中间的缺拍不会被后面出现的另一个「启」顶替。
 */
export function scanFrameStarts(values: Array<string | null>): number[] {
  const starts: number[] = [];
  values.forEach((v, i) => {
    if (v === 'start') starts.push(i);
  });
  return starts;
}

// ---------------- 译码板 / 多来源合并 ----------------

export interface BoardInput {
  cues: Cue[];
  cursor: number;
  policy: Policy;
  choices: Record<string, string>;
  manifests: ForwardManifest[];
  stationLabels: Record<StationId, string>;
}

export interface BoardResult {
  messages: BoardMessage[];
  obsMap: Map<string, Observation>;
}

export function claimValue(claim: Claim, policy: Policy): string | null {
  return policy === 'lenient' ? claim.lenientValue : claim.strictValue;
}

export function buildBoard(input: BoardInput): BoardResult {
  const { cues, cursor, policy, choices, manifests, stationLabels } = input;
  const revealed = cues.slice(0, cursor);
  const obsMap = buildObservationMap(cues, cursor);

  const slotClaims = new Map<string, Claim[]>();
  const msgMeta = new Map<
    string,
    { txId: string | null; startBeat: number | null; sender: StationId | null; minStep: number }
  >();

  const pushClaim = (msgId: string, slot: number, claim: Claim, minStep: number) => {
    const key = `${msgId}:${slot}`;
    if (!slotClaims.has(key)) slotClaims.set(key, []);
    slotClaims.get(key)!.push(claim);
    const meta = msgMeta.get(msgId);
    if (!meta || minStep < meta.minStep) {
      msgMeta.set(msgId, {
        txId: meta?.txId ?? null,
        startBeat: meta?.startBeat ?? null,
        sender: meta?.sender ?? null,
        minStep,
      });
    }
  };

  // 1) 显式申报槽位的补发 / 转发拍
  for (const cue of revealed) {
    if (!cue.assign) continue;
    for (const observer of STATION_IDS) {
      if (observer === cue.sender) continue;
      const obs = obsMap.get(observationKey(cue.id, observer));
      if (!obs) continue;
      const claim: Claim = {
        id: `claim:${observer}:${cue.id}`,
        msgId: cue.assign.msgId,
        slot: cue.assign.slot,
        sourceId: `rcpt:${observer}`,
        sourceLabel: `${stationLabels[observer]}收条`,
        provenance: `${cue.kind === 'resend' ? '补发' : cue.kind === 'forward' ? '转发演示' : '指定槽位'} · 第 ${cue.stepIndex + 1} 拍`,
        kind: 'receipt',
        stepIndex: cue.stepIndex,
        cueId: cue.id,
        observer,
        lenientValue: obs.lenientValue,
        strictValue: obs.strictValue,
        roleValid: true,
        raw: obs,
      };
      pushClaim(cue.assign.msgId, cue.assign.slot, claim, cue.stepIndex);
    }
  }

  // 2) 普通序列：按 发送序列 × 观测台 扫描固定拍帧
  const txGroups = new Map<string, Cue[]>();
  for (const cue of revealed) {
    if (cue.assign) continue;
    if (!txGroups.has(cue.txId)) txGroups.set(cue.txId, []);
    txGroups.get(cue.txId)!.push(cue);
  }

  for (const [txId, txCues] of txGroups) {
    txCues.sort((a, b) => a.beatIndex - b.beatIndex);
    const byBeat = new Map<number, Cue>();
    for (const c of txCues) byBeat.set(c.beatIndex, c);
    const sender = txCues[0]?.sender ?? null;
    const maxBeat = Math.max(...txCues.map((c) => c.beatIndex));

    for (const observer of STATION_IDS) {
      if (sender === observer) continue;
      // 用任一策略能认出「启」作为结构锚点，保证 msgId 稳定
      const anchorValues: Array<string | null> = [];
      for (let b = 0; b <= maxBeat; b++) {
        const cue = byBeat.get(b);
        if (!cue || cue.sender === observer) {
          anchorValues.push(null);
          continue;
        }
        const obs = obsMap.get(observationKey(cue.id, observer));
        anchorValues.push(
          obs && (obs.lenientValue === 'start' || obs.strictValue === 'start')
            ? 'start'
            : null,
        );
      }
      for (const startBeat of scanFrameStarts(anchorValues)) {
        const msgId = `frame:${txId}:${startBeat}`;
        for (let slot = 0; slot < FRAME_LEN; slot++) {
          const beat = startBeat + slot;
          const cue = byBeat.get(beat);
          if (!cue || cue.sender === observer) continue;
          const obs = obsMap.get(observationKey(cue.id, observer));
          if (!obs) continue;
          const claim: Claim = {
            id: `claim:${observer}:${cue.id}`,
            msgId,
            slot,
            sourceId: `rcpt:${observer}`,
            sourceLabel: `${stationLabels[observer]}收条`,
            provenance: `原发序列 · 第 ${cue.stepIndex + 1} 拍（序列第 ${beat + 1} 拍）`,
            kind: 'receipt',
            stepIndex: cue.stepIndex,
            cueId: cue.id,
            observer,
            lenientValue: obs.lenientValue,
            strictValue: obs.strictValue,
            roleValid: true,
            raw: obs,
          };
          pushClaim(msgId, slot, claim, cue.stepIndex);
          const meta = msgMeta.get(msgId)!;
          meta.txId = txId;
          meta.startBeat = startBeat;
          meta.sender = sender;
        }
      }
    }
  }

  // 3) 转发件全文（走到最后一转拍才送达）
  for (const m of manifests) {
    if (cursor <= m.readyStep) continue;
    m.values.forEach((v, slot) => {
      const claim: Claim = {
        id: `manifest:${m.id}:s${slot}`,
        msgId: m.msgId,
        slot,
        sourceId: `fwd:${m.fromStation}`,
        sourceLabel: m.label,
        provenance: '异台转发件（全文）',
        kind: 'forward',
        lenientValue: v,
        strictValue: v,
        roleValid: valueFitsRole(slot, v),
      };
      pushClaim(m.msgId, slot, claim, m.readyStep + 1);
    });
  }

  // 4) 组装每个消息的七个槽位
  const msgIds = [...msgMeta.keys()].sort(
    (a, b) => (msgMeta.get(a)?.minStep ?? 0) - (msgMeta.get(b)?.minStep ?? 0),
  );

  const messages: BoardMessage[] = msgIds.map((msgId) => {
    const meta = msgMeta.get(msgId)!;
    const slots: BoardSlot[] = SLOT_ROLES.map((role, slot) => {
      const claims = slotClaims.get(`${msgId}:${slot}`) ?? [];
      for (const c of claims) c.roleValid = valueFitsRole(slot, claimValue(c, policy));

      const validClaims = claims.filter((c) => c.roleValid);
      const candidateValues = [
        ...new Set(
          validClaims
            .map((c) => claimValue(c, policy))
            .filter((v): v is string => v !== null),
        ),
      ];
      const conflict = candidateValues.length >= 2;
      const choiceKey = `${msgId}:${slot}`;
      const chosenClaimId = choices[choiceKey] ?? null;
      const chosenClaim = chosenClaimId
        ? claims.find((c) => c.id === chosenClaimId) ?? null
        : null;

      let resolvedValue: string | null = null;
      let chosenGap = false;
      if (chosenClaim) {
        const v = claimValue(chosenClaim, policy);
        if (v === null) chosenGap = true;
        else if (chosenClaim.roleValid) resolvedValue = v;
      } else if (candidateValues.length === 1) {
        resolvedValue = candidateValues[0];
      }

      return {
        msgId,
        slot,
        role,
        claims,
        candidateValues,
        conflict,
        chosenClaimId,
        resolvedValue,
        chosenGap,
        missing: resolvedValue === null,
      };
    });

    const values = slots.map((s) => s.resolvedValue);
    const verify = verifyFrame(values);
    const missingSlots = slots.filter((s) => s.missing).map((s) => s.slot);
    const hasUnresolvedConflict = slots.some(
      (s) => s.conflict && !s.chosenClaimId,
    );

    return {
      msgId,
      slots,
      sender: meta.sender,
      txId: meta.txId,
      startBeat: meta.startBeat,
      complete: missingSlots.length === 0,
      checksumOk: verify.ok,
      text: verify.text,
      hasUnresolvedConflict,
      missingSlots,
    };
  });

  return { messages, obsMap };
}
