/// <reference path="../src/types.ts" />
/// <reference path="../src/state-machine.ts" />
/// <reference path="../src/audio-engine.ts" />
/// <reference path="../src/transport.ts" />

// 浏览器内冒烟测试: 真实 AudioContext + 手动 tick 驱动,
// 不依赖墙上时钟(headless 的虚拟时间不推进音频硬件时钟).
namespace Adaptive.Smoke {

  const results: string[] = [];
  let pass = 0;
  let fail = 0;

  function check(cond: boolean, msg: string): void {
    if (cond) { pass++; results.push('PASS ' + msg); }
    else { fail++; results.push('FAIL ' + msg); }
  }

  function ctxOf(t: Transport): AudioContext {
    return (t as unknown as { engine: { ctx: AudioContext } }).engine.ctx;
  }
  function scheduledCount(t: Transport): number {
    return (t as unknown as { engine: { scheduled: unknown[] } }).engine.scheduled.length;
  }
  function findBar(t: Transport, bar: number): { sources: AudioScheduledSourceNode[] } | undefined {
    return (t as unknown as { engine: { scheduled: { bar: number; sources: AudioScheduledSourceNode[] }[] } })
      .engine.scheduled.find((e) => e.bar === bar);
  }
  /** 把音频时钟拨到 time 并驱动一次前瞻/提交循环 */
  function advance(t: Transport, time: number): void {
    const ctx = ctxOf(t);
    Object.defineProperty(ctx, 'currentTime', { value: time, configurable: true, writable: true });
    t.debugTick();
  }
  function advanceBy(t: Transport, seconds: number, step = 0.05): void {
    const end = ctxOf(t).currentTime + seconds;
    while (ctxOf(t).currentTime < end - 1e-9) {
      advance(t, Math.min(end, ctxOf(t).currentTime + step));
    }
  }

  async function main(): Promise<void> {
    const t = new Transport();
    await t.start();
    check(t.isPlaying, 'Transport 进入播放状态(真实 AudioContext 已 resume)');
    check(ctxOf(t).state === 'running', 'AudioContext 处于 running');

    advanceBy(t, 0.2);
    check(scheduledCount(t) >= 1, '前瞻调度已创建真实声源节点');
    check(t.kindAtBar(0) === 'main-calm', 'bar 0 为静区主段');

    // 规则 2: 发声前连点 -> 取消的过门条目被移除, 最新请求挂起
    // 起点偏移 0.15s, 一小节 2.5s: bar 1 下拍在 2.65s, 前瞻窗口 2.35s 才打开.
    // 在窗口外(2.2s)发请求; 再推进到窗口内, bar 1 第一次被排入时就是过门.
    advance(t, 2.2);
    check(!findBar(t, 1), '前瞻窗口尚未打开, bar 1 还没有任何预排');
    t.request('lively');
    advanceBy(t, 0.2); // 走到 2.4s, bar 1 进入前瞻, 以过门身份预排(尚未下拍)
    const fillEntry = findBar(t, 1);
    check(!!fillEntry && fillEntry!.sources.length > 0, '静→闹过门小节已预排真实声源');
    check(t.kindAtBar(1) === 'fill-c2l', '预排的 bar 1 确为静→闹过门而非主段');
    check(!!fillEntry && fillEntry!.sources.length > 0, '静→闹过门小节已预排真实声源');
    t.request('calm');
    check(!findBar(t, 1), '覆盖后过门条目移出预排队列(节点已 stop, 不会发声)');
    check(t.state.getRecords()[0].status === 'superseded', '旧请求标记 superseded');
    check(t.state.getPending()?.status === 'pending', '最新请求保持挂起');

    // 规则 1: 走到 bar 1 下拍 -> 状态提交为过门(听众真正听到)
    t.request('lively');
    advanceBy(t, SECONDS_PER_BAR + 0.05);
    check(isFill(t.state.getCurrentKind()), 'bar 1 下拍后 currentKind 提交为过门');
    check(t.state.getRecords().some((r) => r.status === 'effective' && r.actualFillBar === 1),
      '生效请求记录了实际下拍小节 bar 1');

    // 规则 3: 过门进行中点击 -> merged, 不中断已排声源
    const before = scheduledCount(t);
    const merged = t.request('calm');
    check(merged.status === 'merged', '过门进行中的请求标记为 merged');
    check(scheduledCount(t) === before, '合并请求不移除/中断任何已排声源');

    // 规则 4: 暂停冻结拍位, 恢复继续; 音量不碰拍点
    const beatAtPause = t.currentBeat();
    await t.pause();
    check(ctxOf(t).state === 'suspended', '暂停后 AudioContext 挂起');
    const frozen = t.currentBeat();
    t.setVolume(0.2);
    check(Math.abs(t.currentBeat() - frozen) < 1e-6, '调节音量不改变拍位');
    await t.resume();
    check(ctxOf(t).state === 'running', '恢复后 AudioContext 运行');
    check(Math.abs(t.currentBeat() - beatAtPause) < 1e-6, '恢复后拍位从冻结点继续, 没有重新起拍');

    // 规则 4: reset 清理
    t.reset();
    check(scheduledCount(t) === 0, '从头开始清空预排队列');
    check(t.state.getRecords().length === 0, '从头开始清空请求');

    document.title = fail === 0 ? 'SMOKE OK' : 'SMOKE FAILED';
    document.body.innerHTML =
      `<pre id="result">${fail === 0 ? 'SMOKE OK' : 'SMOKE FAILED'}\n${pass} passed, ${fail} failed\n` +
      results.join('\n') + '</pre>';
  }

  function failNow(err: unknown): void {
    document.title = 'SMOKE ERROR';
    document.body.innerHTML =
      `<pre id="result">SMOKE ERROR\n${String(err && (err as Error).stack ? (err as Error).stack : err)}</pre>`;
  }
  window.addEventListener('error', (e) => failNow(e.message + ' @ ' + (e.filename || '') + ':' + (e.lineno || '')));

  main().catch(failNow);
}
