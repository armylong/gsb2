import { ARRANGEMENTS } from './combos';
import { PLATE_MAP, POSITION_LABELS } from './plates';
import type {
  BandId,
  ConditionKey,
  PlateId,
  Position,
  PuzzleProgress,
  StrikeKind,
} from './types';

export const CONDITION_KEYS: ConditionKey[] = ['all', 'm0', 'm1', 'm2'];

export function conditionKey(kind: StrikeKind): ConditionKey {
  return kind.type === 'all' ? 'all' : (`m${kind.pos}` as ConditionKey);
}

export function keyToKind(key: ConditionKey): StrikeKind {
  return key === 'all' ? { type: 'all' } : { type: 'mute', pos: Number(key[1]) as Position };
}

export function conditionLabel(key: ConditionKey): string {
  if (key === 'all') return '全响';
  return `压住${POSITION_LABELS[Number(key[1]) as Position]}`;
}

export function conditionVerb(key: ConditionKey): string {
  if (key === 'all') return '全响敲响';
  return `压住${POSITION_LABELS[Number(key[1]) as Position]}敲响`;
}

export interface Evidence {
  hasRecord: boolean;
  /** 每个位置粗检出的音高带；未取证为 null */
  bandsByPos: (BandId | null)[];
  /** A/B 对比得到的唯一细指纹；未取得为 null */
  fineByPos: (string | null)[];
  testedKeys: Set<ConditionKey>;
}

export function buildEvidence(progress: PuzzleProgress): Evidence {
  const bandsByPos: (BandId | null)[] = [null, null, null];
  for (const rec of progress.records) {
    rec.analysis.bandsByPos.forEach((b, p) => {
      // 同一固定题的记录必然一致；首次写入即可
      if (bandsByPos[p] === null) bandsByPos[p] = b;
    });
  }
  const fineByPos: (string | null)[] = [null, null, null];
  (Object.entries(progress.fineCodes) as [string, string][]).forEach(([p, code]) => {
    fineByPos[Number(p)] = code;
  });
  return {
    hasRecord: progress.records.length > 0,
    bandsByPos,
    fineByPos,
    testedKeys: new Set(progress.records.map((r) => r.key)),
  };
}

/** 候选摆放是否与当前全部声纹证据一致。 */
export function arrangementMatches(arr: PlateId[], ev: Evidence): boolean {
  for (let p = 0; p < 3; p++) {
    const plate = PLATE_MAP[arr[p]];
    const band = ev.bandsByPos[p];
    if (band !== null && plate.band !== band) return false;
    const fine = ev.fineByPos[p];
    if (fine !== null && plate.fineCode !== fine) return false;
  }
  return true;
}

export function compatibleArrangements(ev: Evidence): PlateId[][] {
  if (!ev.hasRecord) return ARRANGEMENTS;
  return ARRANGEMENTS.filter((a) => arrangementMatches(a, ev));
}

/** 与证据一致的无序组合 id（去重）。 */
export function compatibleComboIds(ev: Evidence): string[] {
  const set = new Set<string>();
  for (const arr of compatibleArrangements(ev)) {
    set.add([...arr].sort(plateOrderCmp).join('+'));
  }
  return [...set];
}

const ORDER = new Map(Object.values(PLATE_MAP).map((p, i) => [p.id, i]));
function plateOrderCmp(a: PlateId, b: PlateId): number {
  return ORDER.get(a)! - ORDER.get(b)!;
}

export interface ConditionAdvice {
  key: ConditionKey;
  label: string;
  tested: boolean;
  /** 在当前候选摆放上，该条件会产生多少种不同的新证据状态 */
  branching: number;
  /** 模拟该条件后，最坏情况下仍与证据一致的组合数 */
  worstComboCount: number;
  /** 对真实题目模拟后，实际会剩下的组合数（用于提示“可唯一锁定”） */
  actualComboCount: number;
  /** 该条件是否能把当前歧义彻底收敛到唯一组合 */
  decisive: boolean;
}

function countCombosForEvidence(ev: Evidence): number {
  return compatibleComboIds(ev).length;
}

/** 模拟：在 ev 基础上加入 condKey（以 hypot 摆放为“听到的真相”）后的证据。 */
function hypotheticalEvidence(
  ev: Evidence,
  condKey: ConditionKey,
  hypot: PlateId[],
): Evidence {
  const bandsByPos = [...ev.bandsByPos] as (BandId | null)[];
  hypot.forEach((id, p) => {
    bandsByPos[p] = PLATE_MAP[id].band;
  });
  const fineByPos = [...ev.fineByPos] as (string | null)[];
  const tested = new Set(ev.testedKeys);
  tested.add(condKey);

  const allTested = tested.has('all');
  if (condKey === 'all') {
    for (let p = 0 as Position; p < 3; p = (p + 1) as Position) {
      if (tested.has(`m${p}` as ConditionKey)) {
        fineByPos[p] = PLATE_MAP[hypot[p]].fineCode;
      }
    }
  } else if (allTested) {
    const p = Number(condKey[1]) as Position;
    fineByPos[p] = PLATE_MAP[hypot[p]].fineCode;
  }
  return { hasRecord: true, bandsByPos, fineByPos, testedKeys: tested };
}

/**
 * 为四个敲击条件生成取证建议。不依赖随机性：分支数由候选摆放枚举得到，
 * actualComboCount 用固定题真值计算，因此“决定性实验”的提示是确定的。
 */
export function adviseConditions(
  ev: Evidence,
  truth: PlateId[],
): ConditionAdvice[] {
  const current = compatibleArrangements(ev);

  return CONDITION_KEYS.map((key) => {
    const tested = ev.testedKeys.has(key);
    if (tested) {
      return {
        key,
        label: conditionLabel(key),
        tested: true,
        branching: 1,
        worstComboCount: countCombosForEvidence(ev),
        actualComboCount: countCombosForEvidence(ev),
        decisive: countCombosForEvidence(ev) === 1,
      };
    }

    const hypotheticalEvidences = current.map((arr) =>
      hypotheticalEvidence(ev, key, arr),
    );
    // 用 JSON 结构去重统计分支
    const branches = new Set(
      hypotheticalEvidences.map((e) =>
        JSON.stringify({ b: e.bandsByPos, f: e.fineByPos }),
      ),
    );
    const worstComboCount = hypotheticalEvidences.reduce((worst, e) => {
      return Math.max(worst, countCombosForEvidence(e));
    }, 1);

    const actualEv = hypotheticalEvidence(ev, key, truth);
    const actualComboCount = countCombosForEvidence(actualEv);

    return {
      key,
      label: conditionLabel(key),
      tested: false,
      branching: branches.size,
      worstComboCount,
      actualComboCount,
      decisive: actualComboCount === 1,
    };
  });
}

/** 提交前的证据状态分类，供 UI 给出明确“信息不足”提示。 */
export type EvidenceStatus =
  | { kind: 'empty'; count: number }
  | { kind: 'unique'; comboId: string }
  | { kind: 'ambiguous'; comboIds: string[] };

export function evidenceStatus(ev: Evidence): EvidenceStatus {
  const ids = compatibleComboIds(ev);
  if (!ev.hasRecord) return { kind: 'empty', count: ids.length };
  if (ids.length === 1) return { kind: 'unique', comboId: ids[0] };
  return { kind: 'ambiguous', comboIds: ids };
}
