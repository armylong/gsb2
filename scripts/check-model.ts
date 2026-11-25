/**
 * 核心模型自检：npm run check
 * 不依赖浏览器 / 音频，只验证组合数、证据等价类与固定题的可解性。
 */
import { COMBOS, comboIdOf } from '../src/game/combos';
import {
  adviseConditions,
  buildEvidence,
  compatibleComboIds,
  evidenceStatus,
} from '../src/game/evidence';
import { PLATES, PUZZLES } from '../src/game/plates';
import { freshProgress } from '../src/game/storage';
import type { BandId, ConditionKey, PuzzleProgress, StrikeRecord } from '../src/game/types';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

function withStrikes(puzzleId: string, keys: ConditionKey[]): PuzzleProgress {
  const puzzle = PUZZLES.find((p) => p.id === puzzleId)!;
  const p = freshProgress(puzzleId);
  const has = (k: ConditionKey) => p.records.some((r) => r.key === k);
  for (const key of keys) {
    if (has(key)) continue;
    const record: StrikeRecord = {
      id: key,
      key,
      at: 0,
      kind: key === 'all' ? { type: 'all' } : { type: 'mute', pos: Number(key[1]) as 0 | 1 | 2 },
      analysis: { bandsByPos: puzzle.truth.map((id) => PLATES.find((x) => x.id === id)!.band) as [BandId, BandId, BandId] },
    };
    p.records.push(record);
    const hasAll = has('all');
    if (hasAll) {
      if (key === 'all') {
        for (const r of p.records) {
          if (r.key.startsWith('m')) {
            const pos = Number(r.key[1]) as 0 | 1 | 2;
            p.fineCodes[pos] = PLATES.find((x) => x.id === puzzle.truth[pos])!.fineCode;
          }
        }
      } else {
        const pos = Number(key[1]) as 0 | 1 | 2;
        p.fineCodes[pos] = PLATES.find((x) => x.id === puzzle.truth[pos])!.fineCode;
      }
    }
  }
  return p;
}

console.log('\n[基础]');
assert(PLATES.length === 6, '共有 6 片公开铃片');
assert(COMBOS.length === 20, '候选组合为 6 选 3 = 20 种');

console.log('\n[第一组 · 清响三音（易）]');
{
  const puzzle = PUZZLES[0];
  const truthCombo = comboIdOf([...puzzle.truth]);
  for (const key of ['all', 'm0', 'm1', 'm2'] as ConditionKey[]) {
    const ev = buildEvidence(withStrikes(puzzle.id, [key]));
    const ids = compatibleComboIds(ev);
    assert(ids.length === 1 && ids[0] === truthCombo, `单次「${key}」后证据唯一指向真实组合`);
  }
}

console.log('\n[第二组 · 近音与叠响（歧义）]');
{
  const puzzle = PUZZLES[1];
  const truthCombo = comboIdOf([...puzzle.truth]);
  const dnPos = puzzle.truth.findIndex((id) => PLATES.find((p) => p.id === id)!.band === 'Dn');
  assert(dnPos >= 0, '真值中存在 D5 近邻音高带位置');

  const evAll = buildEvidence(withStrikes(puzzle.id, ['all']));
  const afterAll = compatibleComboIds(evAll);
  assert(afterAll.length === 2, `全响后严格证据剩 2 种（实际 ${afterAll.length}）`);
  assert(afterAll.includes(truthCombo), '等价集合包含真实组合');
  const rival = afterAll.find((id) => id !== truthCombo)!;
  assert(rival.includes('fu'), '唯一等价对手是用「浮烟」替换「悠商」的组合');

  const status = evidenceStatus(evAll);
  assert(status.kind === 'ambiguous', '证据状态明确判定为“信息不足”');

  const advice = adviseConditions(evAll, [...puzzle.truth]);
  const decisive = advice.filter((a) => !a.tested && a.decisive);
  assert(
    decisive.some((d) => d.key === (`m${dnPos}` as ConditionKey)),
    `建议中压制 Dn 所在的 ${dnPos} 号位为决定性实验`,
  );

  // 确定性可解路径：全响 + 压 Dn 格（共 2 次，预算 3 内）
  const evSolve = buildEvidence(withStrikes(puzzle.id, ['all', `m${dnPos}` as ConditionKey]));
  const solved = compatibleComboIds(evSolve);
  assert(solved.length === 1 && solved[0] === truthCombo, '全响 + 压制近音高格 => 证据唯一');

  // 坏路径：3 次机会 = 全响 + 压另外两格，仍信息不足（提示必须出现）
  const others = [0, 1, 2].filter((p) => p !== dnPos);
  const evBad = buildEvidence(
    withStrikes(puzzle.id, ['all', `m${others[0]}` as ConditionKey, `m${others[1]}` as ConditionKey]),
  );
  const bad = compatibleComboIds(evBad);
  assert(bad.length === 2, `压错两格后仍有 2 种证据相同（实际 ${bad.length}），信息不足状态可达`);

  // 只压三格、不全响：没有 A/B 细指纹，仍然 2 种
  const evMutes = buildEvidence(
    withStrikes(puzzle.id, ['m0', 'm1', 'm2'] as ConditionKey[]),
  );
  assert(compatibleComboIds(evMutes).length === 2, '只压制不全响也仍保留近音高歧义');

  // 预算约束
  assert(puzzle.budget === 3, '两组固定题预算均为 3 次新敲击');
  assert(PUZZLES[0].budget === 3, '易题预算一致');
}

console.log('\n[唯一性]');
{
  // 每个组合在“全部四种条件 + 全部 fine”后都应只匹配自身
  for (const combo of COMBOS) {
    const p = freshProgress('x');
    p.records = (['all', 'm0', 'm1', 'm2'] as ConditionKey[]).map((key, i) => ({
      id: String(i),
      key,
      at: 0,
      kind: key === 'all' ? { type: 'all' as const } : { type: 'mute' as const, pos: Number(key[1]) as 0 | 1 | 2 },
      analysis: { bandsByPos: combo.plates.map((id) => PLATES.find((x) => x.id === id)!.band) as [BandId, BandId, BandId] },
    }));
    p.fineCodes = {
      0: PLATES.find((x) => x.id === combo.plates[0])!.fineCode,
      1: PLATES.find((x) => x.id === combo.plates[1])!.fineCode,
      2: PLATES.find((x) => x.id === combo.plates[2])!.fineCode,
    };
    const ids = compatibleComboIds(buildEvidence(p));
    if (ids.length !== 1 || ids[0] !== combo.id) {
      failures++;
      console.error(`  ✗ 全证据后组合 ${combo.id} 未唯一（得到 ${ids.join(',')}）`);
    }
  }
  if (failures === 0) console.log('  ✓ 20 个组合在完整证据下均可唯一识别');
}

console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`);
process.exit(failures === 0 ? 0 : 1);
