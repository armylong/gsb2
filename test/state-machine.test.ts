/// <reference path="../src/types.ts" />
/// <reference path="../src/state-machine.ts" />

namespace Adaptive.Test {

  let passed = 0;
  let failed = 0;

  function assert(cond: boolean, msg: string): void {
    if (cond) {
      passed++;
    } else {
      failed++;
      console.error(`  ✗ ${msg}`);
    }
  }

  function eq<T>(actual: T, expected: T, msg: string): void {
    assert(actual === expected, `${msg} (期望 ${String(expected)}, 实际 ${String(actual)})`);
  }

  /** 连续推进小节, 返回每小节的 kind 列表 */
  function runBars(sm: MusicStateMachine, count: number): BarKind[] {
    const kinds: BarKind[] = [];
    for (let b = 0; b < count; b++) kinds.push(sm.onBarStart(b).kind);
    return kinds;
  }

  // 规则 1: 主段请求在「下一个整小节边界」插入专用过门, 过门后进入目标主段
  function testBasicTransition(): void {
    const sm = new MusicStateMachine();
    sm.setPlaying(true);
    sm.request('lively', 'user', 2.3); // bar 0 内点击
    const kinds = runBars(sm, 4);
    eq(kinds[0], 'main-calm', 'bar 0 仍是当前静区主段');
    eq(kinds[1], 'fill-c2l', 'bar 1 边界播放静→闹专用过门(整小节, 不在半拍断)');
    eq(kinds[2], 'main-lively', 'bar 2 起进入热闹主段');
    eq(kinds[3], 'main-lively', '热闹主段可循环');
    eq(sm.getCurrentSection(), 'lively', '当前段落已切到热闹区');

    sm.request('calm', 'user', 4 * 4 + 1); // bar 4 内点击
    const more = [sm.onBarStart(4).kind, sm.onBarStart(5).kind, sm.onBarStart(6).kind];
    eq(more[0], 'main-lively', 'bar 4 保持热闹主段');
    eq(more[1], 'fill-l2c', 'bar 5 播放闹→静专用过门');
    eq(more[2], 'main-calm', 'bar 6 回到静区主段');
  }

  // 规则 2: 两次点击都在切换之前 -> 最新请求生效, 被取消的过门不播放, 旧记录 superseded
  function testSupersede(): void {
    const sm = new MusicStateMachine();
    sm.setPlaying(true);
    let invalidated = -1;
    sm.onChange((e) => { if (e.invalidateFromBar !== undefined) invalidated = e.invalidateFromBar; });

    const r1 = sm.request('lively', 'user', 1.0);  // 过门排 bar 1
    const r2 = sm.request('calm', 'user', 3.5);    // 仍在 bar 0, 覆盖 r1
    eq(r1.status, 'superseded', '旧请求被标记 superseded');
    eq(r2.plannedFillBar, 1, '新请求的过门仍排在 bar 1 边界');
    eq(invalidated, 1, '事件通知 Transport 取消 bar 1 起的预排声音');
    const kinds = runBars(sm, 4);
    eq(kinds[1], 'main-calm', '目标已是静区, bar 1 不插任何过门(取消的过门绝不播放)');
    eq(kinds[2], 'main-calm', '继续静区主段循环');
    eq(r2.status, 'same-target', '新请求到点时记录为目标相同, 无转换');
  }

  // 规则 3: 过门已开始 -> 新请求并入, 当前过门演完, 下一次转换按新目标走
  function testMergeDuringFill(): void {
    const sm = new MusicStateMachine();
    sm.setPlaying(true);
    sm.request('lively', 'user', 0.5);
    eq(sm.onBarStart(0).kind, 'main-calm', 'bar 0 静区主段');
    eq(sm.onBarStart(1).kind, 'fill-c2l', 'bar 1 过门开始');

    const merged = sm.request('calm', 'user', 1 * 4 + 2); // 过门进行中(bar 1, 第 2 拍)
    eq(merged.status, 'merged', '过门中新请求标记为并入');
    eq(sm.onBarStart(2).kind, 'main-lively', 'bar 2 当前过门演完, 先落到热闹主段(不打断)');
    eq(merged.plannedFillBar, 3, '并入请求把下一次转换排到 bar 3 边界');
    eq(sm.onBarStart(3).kind, 'fill-l2c', 'bar 3 按新目标播放闹→静过门');
    eq(sm.onBarStart(4).kind, 'main-calm', 'bar 4 进入静区');
    eq(merged.status, 'effective', '并入请求最终生效');
  }

  // 过门中点「目标与过门终点一致」-> 不产生第二次过门
  function testMergeSameTarget(): void {
    const sm = new MusicStateMachine();
    sm.setPlaying(true);
    sm.request('lively', 'user', 0.5);
    sm.onBarStart(0);
    sm.onBarStart(1); // fill-c2l 进行中
    const r = sm.request('lively', 'user', 6); // 过门中点热闹区
    eq(r.status, 'merged', '过门中请求先并入');
    eq(sm.onBarStart(2).kind, 'main-lively', '过门演完进入热闹区');
    eq(r.status, 'same-target', '目标与终点一致, 不再插过门');
    eq(sm.onBarStart(3).kind, 'main-lively', '热闹主段继续循环');
  }

  // 规则 4: 暂停/恢复不改拍位(纯逻辑侧验证 playing 标志与请求存活)
  function testPauseKeepsPending(): void {
    const sm = new MusicStateMachine();
    sm.setPlaying(true);
    const r = sm.request('lively', 'user', 3.9);
    sm.setPlaying(false); // 暂停
    eq(sm.getPending()?.id, r.id, '暂停后挂起请求原样保留');
    sm.setPlaying(true);  // 恢复
    eq(sm.getPending()?.id, r.id, '恢复后挂起请求仍在');
    eq(sm.onBarStart(0).kind, 'main-calm', '恢复后 bar 0 内容不变');
    eq(sm.onBarStart(1).kind, 'fill-c2l', '原计划的 bar 1 过门照常生效');
  }

  // 规则 4: 从头开始清理所有未完成请求
  function testResetClears(): void {
    const sm = new MusicStateMachine();
    sm.setPlaying(true);
    sm.request('lively', 'user', 1);
    sm.request('calm', 'user', 2); // 覆盖第一条
    sm.reset();
    eq(sm.getPending(), null, 'reset 后无挂起请求');
    eq(sm.getCurrentSection(), 'calm', 'reset 回到静区');
    eq(sm.onBarStart(0).kind, 'main-calm', 'reset 后从静区主段重新开始');
    eq(sm.getRecords().length, 0, '旧请求日志已清理');
  }

  // 快速往返三连: 覆盖与生效混合, 检查最终实际发声序列
  function testRapidRoundTrip(): void {
    const sm = new MusicStateMachine();
    sm.setPlaying(true);
    const a = sm.request('lively', 'user', 0.6);
    const b = sm.request('calm', 'user', 1.1);    // bar 0 内覆盖 a
    const c = sm.request('lively', 'user', 2.6);  // 仍在 bar 0, 再覆盖 b
    eq(a.status, 'superseded', '请求 a 被覆盖, 其过门不播放');
    eq(b.status, 'superseded', '请求 b 被覆盖, 其过门不播放');
    const kinds = runBars(sm, 5);
    eq(kinds[0], 'main-calm', 'bar 0 静区');
    eq(kinds[1], 'fill-c2l', '只有最新请求 c 的过门在 bar 1 发声');
    eq(kinds[2], 'main-lively', 'bar 2 热闹区');
    eq(kinds[3], 'main-lively', 'bar 3 热闹主段循环');
    eq(c.status, 'effective', '请求 c 生效, 实际过门 bar 1');
    eq(c.actualFillBar, 1, '记录的实际生效小节可回看');
    eq(c.plannedFillBar, 1, '预计与实际一致');
  }

  // 同段落重复点击不插过门
  function testSameTargetNoFill(): void {
    const sm = new MusicStateMachine();
    sm.setPlaying(true);
    const r = sm.request('calm', 'user', 2);
    eq(r.status, 'same-target', '目标与当前段落一致 -> same-target');
    const kinds = runBars(sm, 3);
    eq(kinds.every((k) => k === 'main-calm'), true, '全程只有静区主段, 无过门');
  }

  const tests: [string, () => void][] = [
    ['规则1 小节边界换编排 + 两套主段循环', testBasicTransition],
    ['规则2 切换前连点按最新请求, 取消过门不播放', testSupersede],
    ['规则3 过门中请求并入, 演完后按新目标转换', testMergeDuringFill],
    ['规则3 并入请求目标与过门终点一致', testMergeSameTarget],
    ['规则4 暂停恢复保持挂起请求与拍位', testPauseKeepsPending],
    ['规则4 从头开始清理旧请求', testResetClears],
    ['规则5 快速往返的预计/实际拍位记录', testRapidRoundTrip],
    ['同段落点击不产生过门', testSameTargetNoFill],
  ];

  for (const [name, fn] of tests) {
    console.log(`\n● ${name}`);
    fn();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
