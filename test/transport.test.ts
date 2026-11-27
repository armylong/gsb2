/// <reference path="../src/types.ts" />
/// <reference path="../src/state-machine.ts" />
/// <reference path="../src/audio-engine.ts" />
/// <reference path="../src/transport.ts" />

namespace Adaptive.Test {

  // ---------- Mock Web Audio / DOM 环境 ----------
  let nextId = 1;

  class MockParam {
    value = 0;
    setValueAtTime(): void { /* no-op */ }
    linearRampToValueAtTime(): void { /* no-op */ }
    exponentialRampToValueAtTime(): void { /* no-op */ }
    setTargetAtTime(v: number): void { this.value = v; }
  }

  class MockNode {
    id = nextId++;
    cancelled = false;   // stop() 无参调用 = 立即取消(被 supersede/reset)
    startedAt: number | null = null;
    stopAt: number | null = null; // stop(t) 带未来时间 = 排程自然结束
    connections: MockNode[] = [];
    type = '';
    frequency = new MockParam();
    detune = new MockParam();
    Q = new MockParam();
    gain = new MockParam();
    buffer: unknown = null;
    loop = false;
    start(t: number): void { this.startedAt = t; }
    /** 真实 Web Audio: 无参 stop() 立即停止; 带时间戳是排程结束, 声源仍会发声到该时刻 */
    stop(t?: number): void {
      if (t === undefined) { this.cancelled = true; }
      else { this.stopAt = t; }
    }
    get stopped(): boolean { return this.cancelled; }
    sounding(at: number): boolean {
      return !this.cancelled && this.startedAt !== null &&
        this.startedAt <= at && (this.stopAt === null || this.stopAt > at);
    }
    connect(n: MockNode): MockNode { this.connections.push(n); return n; }
    disconnect(): void { /* no-op */ }
  }

  class MockAudioContext {
    currentTime = 0;
    sampleRate = 44100;
    destination = new MockNode();
    createOscillator(): MockNode { const n = new MockNode(); n.type = 'osc'; return n; }
    createGain(): MockNode { const n = new MockNode(); n.type = 'gain'; return n; }
    createDynamicsCompressor(): MockNode { const n = new MockNode(); n.type = 'comp'; return n; }
    createBiquadFilter(): MockNode { const n = new MockNode(); n.type = 'filter'; return n; }
    createBufferSource(): MockNode { const n = new MockNode(); n.type = 'buffer'; return n; }
    createBuffer(_channels: number, len: number): { getChannelData: () => Float32Array } {
      return { getChannelData: () => new Float32Array(len) };
    }
    suspend(): Promise<void> { return Promise.resolve(); }
    resume(): Promise<void> { return Promise.resolve(); }
  }

  function installMocks(): void {
    nextId = 1;
    (globalThis as unknown as { window: unknown }).window = {
      AudioContext: MockAudioContext,
      webkitAudioContext: MockAudioContext,
      setInterval: (): number => 0,
      clearInterval: (): void => undefined,
    };
  }

  let passed2 = 0;
  let failed2 = 0;
  function check(cond: boolean, msg: string): void {
    if (cond) { passed2++; } else { failed2++; console.error(`  ✗ ${msg}`); }
  }

  function advance(t: Transport, seconds: number, step = 0.02): void {
    const ctx = (t as unknown as { engine: { ctx: MockAudioContext } }).engine.ctx;
    const target = ctx.currentTime + seconds;
    while (ctx.currentTime < target - 1e-9) {
      ctx.currentTime = Math.min(target, ctx.currentTime + step);
      t.debugTick();
    }
  }

  function barSources(t: Transport, bar: number): MockNode[] {
    const entry = (t as unknown as { engine: { scheduled: { bar: number; sources: MockNode[] }[] } })
      .engine.scheduled.find((e) => e.bar === bar);
    return entry ? entry.sources : [];
  }

  function allSources(t: Transport): MockNode[] {
    return (t as unknown as { engine: { scheduled: { sources: MockNode[] }[] } })
      .engine.scheduled.flatMap((e) => e.sources);
  }

  // Transport: 启动后按小节边界排声音, 拍位换算与音频时钟一致
  async function testTransportSchedulesBars(): Promise<void> {
    installMocks();
    const t = new Transport();
    await t.start();
    advance(t, 0.3);
    const srcs = barSources(t, 0);
    check(srcs.length > 0, '前瞻窗口内已排入第一小节的声音');
    // originAudioTime = 启动时 currentTime + 0.15, 第一小节所有声音起点 >= 0.15
    check(srcs.every((s) => (s.startedAt ?? 0) >= 0.15 - 1e-9), '声音起点对齐音频时钟上的整小节边界');
    check(t.kindAtBar(0) === 'main-calm', 'bar 0 规划为静区主段');

    advance(t, SECONDS_PER_BAR * 2);
    check(t.kindAtBar(1) === 'main-calm', '无请求时 bar 1 仍是静区主段(循环)');
    const expectedBeat = (0.3 + SECONDS_PER_BAR * 2 - 0.15) / SECONDS_PER_BEAT;
    check(Math.abs(t.currentBeat() - expectedBeat) < 0.05, 'currentBeat 与音频时钟流逝一致');
  }

  // 规则 2 的音频侧: 覆盖请求把尚未发声的预排过门 stop 掉, 它绝不发声
  async function testCancelledFillNeverSounds(): Promise<void> {
    installMocks();
    const t = new Transport();
    await t.start();
    advance(t, 0.3);                                 // 只排到 bar 0
    t.request('lively');                             // bar 0 内 -> 过门计划 bar 1
    advance(t, 2.2);                                 // 走到 bar 1 边界前, 过门已预排(尚未发声)
    check(t.kindAtBar(1) === 'fill-c2l', 'bar 1 先被规划为静→闹过门');
    const fillSources = barSources(t, 1).slice();    // 先抓住声源引用(取消后条目会移出队列)
    check(fillSources.length > 0, '过门小节确实已预排声源');

    t.request('calm');                               // 仍在 bar 0, 覆盖上一请求
    check(fillSources.every((s) => s.stopped), '预排过门的全部声源被 stop, 取消的过门不会播放');
    check(t.kindAtBar(1) === null, 'bar 1 规划被回滚, 等待按新请求重排');

    advance(t, SECONDS_PER_BAR * 1.5);
    check(t.kindAtBar(1) === 'main-calm', '重排后 bar 1 为静区主段, 无过门');
  }

  // 规则 3 的音频侧: 过门开始后到达的请求不 stop 任何正在发声的声源
  async function testMergeDoesNotInterruptSoundingFill(): Promise<void> {
    installMocks();
    const t = new Transport();
    await t.start();
    t.request('lively');
    advance(t, SECONDS_PER_BAR * 1.6); // 走过 bar 0, bar 1 过门正在发声
    check(t.kindAtBar(1) === 'fill-c2l', 'bar 1 过门正在播放');
    const ctx = (t as unknown as { engine: { ctx: MockAudioContext } }).engine.ctx;
    const sounding = allSources(t).filter((s) => s.sounding(ctx.currentTime));
    check(sounding.length > 0, '存在已起振且未结束的声源');

    t.request('calm'); // 过门中改道
    check(sounding.every((s) => !s.stopped), '并入请求没有中断任何已起振的声音, 当前过门演完');

    advance(t, SECONDS_PER_BAR * 2.5);
    check(t.kindAtBar(2) === 'main-lively', 'bar 2 先落热闹主段');
    check(t.kindAtBar(3) === 'fill-l2c', 'bar 3 按并入请求的新目标播放闹→静过门');
  }

  // 规则 4: 暂停/恢复拍位保持; 音量变化不触碰拍点
  async function testPauseResumeAndVolume(): Promise<void> {
    installMocks();
    const t = new Transport();
    await t.start();
    t.request('lively');
    advance(t, 1.0);
    const beatBefore = t.currentBeat();
    const pendingId = t.state.getPending()?.id;
    const masterGain = (t as unknown as { engine: { master: { gain: MockParam } } }).engine.master.gain;

    t.setVolume(0.3);
    check(Math.abs(masterGain.value - 0.3) < 1e-9, '音量改动只作用于增益节点');
    check(Math.abs(t.currentBeat() - beatBefore) < 1e-9, '改音量不改变拍位(不重新起拍)');

    await t.pause();
    const beatPaused = t.currentBeat();
    check(Math.abs(t.currentBeat() - beatPaused) < 1e-9, '暂停瞬间拍位冻结');
    check(t.state.getPending()?.id === pendingId, '暂停后挂起请求原样保留');

    await t.resume();
    advance(t, 1.0); // 真实环境中 suspend 期间时钟冻结, 恢复后从冻结点继续
    check(t.currentBeat() > beatPaused, '恢复后拍位从冻结点继续, 而非重新起拍');
    check(t.state.getPending()?.id === pendingId, '恢复后挂起请求仍在, 原计划边界不变');
  }

  // 规则 4: 从头开始取消全部声音并清空请求
  async function testResetCancelsAll(): Promise<void> {
    installMocks();
    const t = new Transport();
    await t.start();
    t.request('lively');
    advance(t, 0.5);
    const snapshot = allSources(t);
    check(snapshot.length > 0, '已有预排声音');
    t.reset();
    check(snapshot.every((s) => s.stopped), 'reset 停掉全部预排声音');
    check(allSources(t).length === 0, '预排队列清空');
    check(t.state.getRecords().length === 0, 'reset 清空请求记录');
    check(t.state.getPending() === null, 'reset 无挂起请求');
  }

  const tests2: [string, () => Promise<void>][] = [
    ['Transport 按音频时钟在小节边界排声音', testTransportSchedulesBars],
    ['Transport 覆盖请求时取消的过门绝不发声', testCancelledFillNeverSounds],
    ['Transport 并入请求不打断正在播放的过门', testMergeDoesNotInterruptSoundingFill],
    ['Transport 暂停恢复拍位保持 + 音量不重启拍点', testPauseResumeAndVolume],
    ['Transport 从头开始清理声音与请求', testResetCancelsAll],
  ];

  (async () => {
    for (const [name, fn] of tests2) {
      console.log(`\n● ${name}`);
      await fn();
    }
    console.log(`\n[transport] ${passed2} passed, ${failed2} failed`);
    if (failed2 > 0) process.exit(1);
  })();
}
