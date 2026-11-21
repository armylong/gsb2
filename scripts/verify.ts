/**
 * 命令行核查：同一批射线、同一套裁决规则，逐分组上限比对“加速路径 vs 逐件求交”。
 *
 *   npm run verify
 *   npm run verify -- --rays 800 --seed 20260422
 *
 * 退出码 0 表示全部通过，1 表示有不一致（或场景生成失败）。
 */
import {
  CAPACITY_PRESETS,
  DEFAULT_OBJECT_COUNT,
  DEFAULT_SEED,
  buildRayBatch,
  generateScene,
} from '../src/core/scene';
import {
  buildBvh,
  objectAabb,
  pickBrute,
  pickWithBvh,
  sameOutcome,
} from '../src/core/picking';
import { boxContains, rayHitsBox } from '../src/core/geometry';
import type { PickOutcome } from '../src/core/types';

interface Options {
  seed: number;
  rays: number;
  capacities: number[];
}

function parseOptions(argv: string[]): Options {
  let seed = DEFAULT_SEED;
  let rays = 300;
  let capacities: number[] = [...CAPACITY_PRESETS];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--seed') seed = Number(argv[++i]);
    else if (arg === '--rays') rays = Number(argv[++i]);
    else if (arg === '--capacity') {
      capacities = String(argv[++i])
        .split(',')
        .map(Number)
        .filter((n) => Number.isFinite(n) && n >= 1);
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法: npm run verify -- [--seed N] [--rays N] [--capacity 1,2,4,8,16,32]');
      process.exit(0);
    }
  }
  if (!Number.isFinite(seed)) throw new Error('--seed 必须是整数');
  if (!Number.isFinite(rays) || rays < 1) throw new Error('--rays 必须是正整数');
  if (capacities.length === 0) capacityError();
  return { seed, rays, capacities };
}

function capacityError(): never {
  throw new Error('--capacity 需要至少一个正整数，例如 --capacity 1,4,8,16');
}

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail: string): boolean {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function pct(n: number, d: number): string {
  if (d === 0) return '—';
  return `${((n / d) * 100).toFixed(1)}%`;
}

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

function ids(outcome: PickOutcome): number[] {
  return outcome.hits.map((h) => h.objectId);
}

function summarizePick(outcome: PickOutcome): string {
  const sel = outcome.selected;
  if (!sel) return '无命中';
  return `#${sel.objectId} t=${sel.t.toFixed(4)}${sel.inside ? ' (inside)' : ''}`;
}

function main(): number {
  const opts = parseOptions(process.argv.slice(2));
  console.log('场景拾取核查');
  console.log(`  seed=${opts.seed}  count=${DEFAULT_OBJECT_COUNT}  rays=${opts.rays}`);
  console.log(`  capacities=${opts.capacities.join(', ')}`);
  console.log('');

  const scene = generateScene(opts.seed, DEFAULT_OBJECT_COUNT);
  const objectsById = new Map(scene.objects.map((o) => [o.id, o]));
  const total = scene.objects.length;
  console.log(`场景：${total} 件物件（含 ${scene.rays.length} 条固定演示射线）`);

  console.log('\n[1] 固定种子可复现');
  const scene2 = generateScene(opts.seed, DEFAULT_OBJECT_COUNT);
  const sameLayout = scene.objects.every((o, i) => {
    const p = scene2.objects[i];
    return (
      p.id === o.id &&
      p.position.equals(o.position) &&
      p.quaternion.equals(o.quaternion) &&
      p.size.equals(o.size)
    );
  });
  check('同一 seed 生成完全相同的布局', sameLayout, `${total} 件逐一比对`);
  const idsUnique = new Set(scene.objects.map((o) => o.id)).size === total;
  check('物件 id 唯一', idsUnique, `id 0..${total - 1}`);

  console.log('\n[2] 演示射线的裁决规则');
  const byTag = new Map(scene.rays.map((r) => [r.tag, r]));
  const runOne = (tag: string): PickOutcome => {
    const ray = byTag.get(tag);
    if (!ray) throw new Error(`缺少演示射线 ${tag}`);
    return pickBrute(scene.objects, ray.origin, ray.direction);
  };

  const nested = runOne('nested');
  const nestedHitIds = ids(nested);
  check(
    '嵌套：外壳与内球都进入命中列表，最近者胜出',
    nestedHitIds[0] === scene.specials.nestedOuterId &&
      nestedHitIds.includes(scene.specials.nestedInnerId),
    `命中 ${nestedHitIds.map((id) => `#${id}`).join(' → ')}；选中 #${nested.selected?.objectId}`,
  );

  const inside = runOne('inside');
  const insideObj = objectsById.get(scene.specials.insideId)!;
  check(
    '射线从物体内部发射：该物体以 t=0 胜出并标记 inside',
    inside.selected?.objectId === scene.specials.insideId &&
      inside.selected?.t === 0 &&
      inside.selected?.inside === true &&
      inside.hits.some((h) => h.objectId === insideObj.id && h.t === 0),
    summarizePick(inside),
  );

  const tie = runOne('tie');
  check(
    '两个等距球：并列由 id 小者胜出（与遍历/分组无关）',
    tie.selected?.objectId === Math.min(...scene.specials.tieIds) &&
      tie.tieIds.length === 2 &&
      tie.tieIds.includes(scene.specials.tieIds[0]) &&
      tie.tieIds.includes(scene.specials.tieIds[1]),
    `并列 #${tie.tieIds.join(' / #')} t=${tie.tieT?.toFixed(4)} → 选中 #${tie.selected?.objectId}`,
  );

  const aabbRay = byTag.get('aabb')!;
  const aabbOutcome = runOne('aabb');
  const fpId = scene.specials.aabbFalsePositiveId;
  const fpObj = objectsById.get(fpId)!;
  const aabbHits = rayHitsBox(aabbRay.origin, aabbRay.direction, objectAabb(fpObj));
  check(
    'AABB 误报：包围盒被穿过但精确求交无命中',
    aabbHits && aabbOutcome.selected === null && aabbOutcome.hits.length === 0,
    `AABB 命中 #${fpId}，精确命中 ${aabbOutcome.hits.length} 件`,
  );

  console.log('\n[3] 分组边界完整性');
  let boundaryOk = true;
  let boundaryDetail = '';
  for (const capacity of opts.capacities) {
    const bvh = buildBvh(scene.objects, capacity);
    for (const leaf of bvh.leaves) {
      for (const id of leaf.objectIds) {
        const obj = objectsById.get(id)!;
        if (!boxContains(leaf.box, objectAabb(obj))) {
          boundaryOk = false;
          boundaryDetail = `capacity=${capacity} 叶组 ${leaf.id} 未包住 #${id}`;
          break;
        }
      }
      if (!boundaryOk) break;
    }
    const grouped = bvh.leaves.reduce((s, l) => s + l.objectIds.length, 0);
    if (grouped !== total) {
      boundaryOk = false;
      boundaryDetail = `capacity=${capacity} 累计 ${grouped} 件 != ${total}`;
    }
    if (!boundaryOk) break;
  }
  check(
    '每个叶组包围盒包住其全部物件的 AABB，且不重不漏',
    boundaryOk,
    boundaryDetail || `${opts.capacities.length} 个分组上限`,
  );

  console.log('\n[4] 同一批射线：加速路径 vs 逐件求交');
  const batch = buildRayBatch(scene, opts.rays);
  console.log(`  射线批次：${batch.length} 条（固定演示 ${scene.rays.length} 条 + 随机 ${opts.rays} 条）`);

  const header = [
    '上限',
    '组数',
    '进深',
    '平均候选',
    '最大候选',
    '平均访问组',
    '平均节点',
    '加速 ms',
    '逐件 ms',
    '一致',
  ];
  console.log(`\n${header.map((h, i) => (i === 0 ? h.padEnd(6) : h.padStart(10))).join('')}`);

  let allAgree = true;
  let mismatchTotal = 0;
  const perCapacity: Array<{ capacity: number; groups: number; avgCandidates: number }> = [];

  for (const capacity of opts.capacities) {
    const bvh = buildBvh(scene.objects, capacity);
    let mismatches = 0;
    const firstMismatches: string[] = [];
    let sumCand = 0;
    let maxCand = 0;
    let sumGroups = 0;
    let maxGroups = 0;
    let sumNodes = 0;
    let accelMs = 0;
    let bruteMs = 0;

    for (const ray of batch) {
      const accel = pickWithBvh(bvh, objectsById, ray.origin, ray.direction).outcome;
      const brute = pickBrute(scene.objects, ray.origin, ray.direction);
      accelMs += accel.elapsedMs;
      bruteMs += brute.elapsedMs;

      const cand = accel.candidateIds.length;
      sumCand += cand;
      maxCand = Math.max(maxCand, cand);
      sumGroups += accel.visitedGroupIds.length;
      maxGroups = Math.max(maxGroups, accel.visitedGroupIds.length);
      sumNodes += accel.nodesTested;

      if (!sameOutcome(accel, brute)) {
        mismatches++;
        if (firstMismatches.length < 3) {
          firstMismatches.push(
            `${ray.label}: 加速#${accel.selected?.objectId ?? '-'} vs 逐件#${brute.selected?.objectId ?? '-'}`,
          );
        }
      }
    }

    allAgree &&= mismatches === 0;
    mismatchTotal += mismatches;
    const n = batch.length;
    perCapacity.push({ capacity, groups: bvh.leaves.length, avgCandidates: sumCand / n });

    console.log(
      [
        String(capacity).padEnd(6),
        String(bvh.leaves.length).padStart(10),
        String(bvh.maxDepth).padStart(10),
        fmt(sumCand / n, 1).padStart(10),
        String(maxCand).padStart(10),
        fmt(sumGroups / n, 1).padStart(10),
        fmt(sumNodes / n, 1).padStart(10),
        fmt(accelMs, 1).padStart(10),
        fmt(bruteMs, 1).padStart(10),
        (mismatches === 0 ? '是' : `否(${mismatches})`).padStart(10),
      ].join(''),
    );
    if (mismatches > 0) {
      for (const line of firstMismatches) console.log(`         ↳ ${line}`);
    }
  }

  check(
    '所有分组上限下，选中物件 / 命中列表 / 并列组完全一致',
    allAgree,
    allAgree ? `${batch.length} 条射线 × ${opts.capacities.length} 种上限` : `${mismatchTotal} 处不一致`,
  );

  const single = perCapacity.find((p) => p.capacity === 1);
  const coarse = perCapacity.find((p) => p.capacity === 32);
  if (single && coarse) {
    check(
      '分组越细，候选越少（代价是更多节点/分组访问）',
      single.avgCandidates <= coarse.avgCandidates,
      `上限 1 平均候选 ${fmt(single.avgCandidates, 1)}，上限 32 平均候选 ${fmt(coarse.avgCandidates, 1)}`,
    );
  }

  // 候选占比说明加速比来自哪里：候选越少，窄相位求交越少。
  console.log('\n[5] 候选占比（相对物件总数）');
  for (const p of perCapacity) {
    console.log(
      `  上限 ${String(p.capacity).padStart(2)}，${String(p.groups).padStart(3)} 组，` +
        `平均候选 ${fmt(p.avgCandidates, 1)} / ${total}（${pct(p.avgCandidates, total)}）`,
    );
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('');
  if (failed.length === 0) {
    console.log(`全部 ${checks.length} 项检查通过。`);
    return 0;
  }
  console.log(`${failed.length} / ${checks.length} 项检查失败：`);
  for (const f of failed) console.log(`  - ${f.name}（${f.detail}）`);
  return 1;
}

try {
  process.exit(main());
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
