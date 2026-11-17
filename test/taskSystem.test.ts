import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerrainTaskSystem, type RequestDescriptor } from '../src/terrain/taskSystem';
import { selectLod } from '../src/terrain/lodSelector';
import { CHUNK_COUNT } from '../src/terrain/config';

function makeSystem(seed = 7): TerrainTaskSystem {
  return new TerrainTaskSystem(seed, CHUNK_COUNT, CHUNK_COUNT);
}

function respond(sys: TerrainTaskSystem, req: RequestDescriptor, payload = {}) {
  return sys.handleResult({
    requestId: req.requestId,
    terrainEpoch: req.terrainEpoch,
    cx: req.cx,
    cz: req.cz,
    lod: req.lod,
    payload,
  });
}

test('人为打乱完成顺序:迟到的旧 LOD 结果不会覆盖新层级', () => {
  const sys = makeSystem();
  const r0 = sys.requestChunk(0, 0, 0);
  assert.ok(r0);
  // 相机快速远离:同一块改要 LOD2,LOD0 请求被取代
  const r2 = sys.requestChunk(0, 0, 2);
  assert.ok(r2);
  assert.equal(sys.stats.totalSuperseded, 1);

  // 故意让 LOD0 的慢任务先"回来"
  const stale = respond(sys, r0);
  assert.equal(stale, null);
  assert.equal(sys.stats.totalStale, 1);
  assert.equal(sys.getChunk(0, 0).currentLod, null);

  const applied = respond(sys, r2);
  assert.ok(applied);
  assert.equal(applied?.lod, 2);
  assert.equal(sys.getChunk(0, 0).currentLod, 2);
});

test('请求去重:相同层级在途时不重复发任务', () => {
  const sys = makeSystem();
  const a = sys.requestChunk(1, 1, 1);
  const b = sys.requestChunk(1, 1, 1);
  assert.ok(a);
  assert.equal(b, null);
  assert.equal(sys.stats.totalRequested, 1);
});

test('结果应用后再次请求同层级直接命中,不产生新任务', () => {
  const sys = makeSystem();
  const r = sys.requestChunk(2, 2, 0)!;
  respond(sys, r);
  assert.equal(sys.requestChunk(2, 2, 0), null);
  assert.equal(sys.stats.totalRequested, 1);
});

test('换种子(地形代数递增)后旧代数结果全部过期,旧网格不覆盖新地形', () => {
  const sys = makeSystem(1);
  const old = sys.requestChunk(0, 0, 0)!;
  sys.rebuild(2);
  assert.equal(sys.terrainEpoch, 1);
  assert.equal(sys.stats.totalSuperseded, 1);

  const stale = respond(sys, old);
  assert.equal(stale, null);
  assert.equal(sys.stats.totalStale, 1);
  assert.equal(sys.getChunk(0, 0).currentLod, null);

  const fresh = sys.requestChunk(0, 0, 0)!;
  assert.equal(fresh.terrainEpoch, 1);
  const applied = respond(sys, fresh);
  assert.ok(applied);
  assert.equal(sys.getChunk(0, 0).currentEpoch, 1);
});

test('快速往返产生的请求链以乱序完成时,最终层级等于最后一次请求', () => {
  const sys = makeSystem();
  const seq = [0, 2, 1, 2, 0, 1].map((lod) => sys.requestChunk(3, 3, lod)!);
  assert.equal(seq.length, 6);
  // 全部仍未完成,因此每次都产生新请求;前 5 个被取代
  assert.equal(sys.stats.totalSuperseded, 5);
  assert.equal(sys.stats.pending, 6);

  // 乱序:按 requestId 从大到小完成
  const results: Array<number | null> = [];
  for (let i = seq.length - 1; i >= 0; i--) {
    const r = respond(sys, seq[i]);
    results.push(r === null ? null : r.lod);
  }
  // 只有最新请求被应用,且应用的是最后请求的 LOD=1
  assert.deepEqual(results, [1, null, null, null, null, null]);
  assert.equal(sys.getChunk(3, 3).currentLod, 1);
  assert.equal(sys.stats.totalStale, 5);
  assert.equal(sys.stats.pending, 0);
});

test('cancelQueued 仅清理台账并回退 pending,不重复计取代', () => {
  const sys = makeSystem();
  const r1 = sys.requestChunk(0, 0, 0)!;
  const r2 = sys.requestChunk(0, 0, 2)!;
  const supBefore = sys.stats.totalSuperseded;
  // r1 已被 r2 取代,出队前取消
  assert.equal(sys.cancelQueued(r1.requestId), true);
  assert.equal(sys.stats.totalSuperseded, supBefore);
  assert.equal(sys.isRequestLive(r1.requestId), false);
  assert.equal(sys.isRequestLive(r2.requestId), true);
  // 取消未知请求返回 false
  assert.equal(sys.cancelQueued(99999), false);
});

test('全部块满足期望且无在途任务时收敛,否则不收敛', () => {
  const sys = makeSystem();
  assert.equal(sys.isConverged(), false);
  const reqs = [];
  for (let cx = 0; cx < CHUNK_COUNT; cx++) {
    for (let cz = 0; cz < CHUNK_COUNT; cz++) {
      reqs.push(sys.requestChunk(cx, cz, (cx + cz) % 3)!);
    }
  }
  assert.equal(sys.isConverged(), false);
  for (const r of reqs) respond(sys, r);
  assert.equal(sys.isConverged(), true);
  assert.equal(sys.stats.pending, 0);
});

test('迟滞:阈值附近抖动不会在两个 LOD 间反复跳动', () => {
  const ranges = { near: 70, far: 140, hysteresis: 12 };
  let lod = selectLod(60, ranges, null); // 进入 LOD0
  assert.equal(lod, 0);
  // 越过 70 但未越过 70+12:保持 LOD0
  lod = selectLod(75, ranges, lod);
  assert.equal(lod, 0);
  lod = selectLod(81.9, ranges, lod);
  assert.equal(lod, 0);
  // 超过上迟滞边界才降到 LOD1
  lod = selectLod(83, ranges, lod);
  assert.equal(lod, 1);
  // 回落到阈值上方但未严格低于 70-12=58:保持 LOD1
  lod = selectLod(60, ranges, lod);
  assert.equal(lod, 1);
  lod = selectLod(59, ranges, lod);
  assert.equal(lod, 1);
  // 严格低于下迟滞边界 58 才升回 LOD0
  lod = selectLod(57, ranges, lod);
  assert.equal(lod, 0);
});

test('在阈值带内反复横跳 100 次层级保持稳定', () => {
  const ranges = { near: 70, far: 140, hysteresis: 12 };
  let lod = selectLod(65, ranges, null);
  let switches = 0;
  for (let i = 0; i < 100; i++) {
    const d = i % 2 === 0 ? 66 : 79;
    const next = selectLod(d, ranges, lod);
    if (next !== lod) switches += 1;
    lod = next;
  }
  assert.equal(switches, 0);
});
