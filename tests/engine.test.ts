/**
 * 计时规则引擎验证 —— 不依赖浏览器/DOM，vitest 直接在 Node 下运行。
 * 运行：npm test
 */
import { describe, it, expect } from 'vitest';
import { createTrack } from '../src/engine/track';
import { LapSession } from '../src/engine/session';
import { buildSamples } from '../src/engine/samples';
import { Path, withAutoAngles } from '../src/engine/path';
import { recordLapOffline, Ghost, Recorder } from '../src/engine/ghost';
import { v } from '../src/engine/geometry';

const track = createTrack();
const samples = buildSamples(track);
const sample = (id: string) => samples.find((s) => s.id === id)!;

/** 以固定步长沿路径驱动会话，返回会话（暂停期间整个模拟冻结，路径时钟也挂起） */
function runPath(path: Path, hz: number, pauseWindows: Array<[number, number]> = []): LapSession {
  const session = new LapSession(track, path.frames[0].pos);
  const start = path.frames[0].t;
  const end = path.frames[path.frames.length - 1].t;
  const dt = 1 / hz;
  // pauseWindows 以"墙钟"计；引擎模拟时钟在暂停时不前进，故用墙钟游标判断窗口
  let wallClock = 0;
  let pathT = start;
  const inPause = (t: number) => pauseWindows.some(([a, b]) => t >= a && t < b);
  while (pathT < end - 1e-12) {
    const step = Math.min(dt, end - pathT);
    if (inPause(wallClock + step / 2)) {
      session.pause();
      session.advance(step, session.pos, session.angle); // 全冻结：位置不变、路径不前进
      session.resume();
    } else {
      pathT += step;
      const s = path.sampleAt(pathT);
      session.advance(step, s.pos, s.angle);
    }
    wallClock += step;
  }
  return session;
}

/** 不规则时间步长（模拟掉帧/抖动），但总时长一致 */
function runPathIrregular(path: Path, pattern: number[]): LapSession {
  const session = new LapSession(track, path.frames[0].pos);
  const start = path.frames[0].t;
  const end = path.frames[path.frames.length - 1].t;
  let t = start;
  let i = 0;
  while (t < end - 1e-12) {
    const dt = Math.min(pattern[i % pattern.length], end - t);
    const s = path.sampleAt(t + dt);
    session.advance(dt, s.pos, s.angle);
    t += dt;
    i++;
  }
  return session;
}

const gateEvents = (s: LapSession) => s.events.filter((e) => e.kind !== 'lap');
const kinds = (s: LapSession) => gateEvents(s).map((e) => `${e.gate}:${e.kind}`);

describe('正常路线与圈速', () => {
  it('valid 样例在 60Hz 下产出 1 个有效圈，闸门顺序为 G0..G3', () => {
    const s = runPath(sample('valid').path, 60);
    expect(s.lapCount).toBe(1);
    expect(kinds(s)).toEqual([
      '0:gate-hit',
      '1:gate-hit',
      '2:gate-hit',
      '3:gate-hit',
    ]);
    const lap = s.laps[0];
    expect(lap.gateTimes).toHaveLength(4);
    expect(lap.gateTimes[0]).toBeCloseTo(0, 6);
    expect(lap.total).toBeGreaterThan(0);
    // 分段计时单调递增
    for (let i = 1; i < 4; i++) expect(lap.gateTimes[i]).toBeGreaterThan(lap.gateTimes[i - 1]);
  });  it('贴边样例同样有效（闸门横跨整个跑道宽度）', () => {
    const s = runPath(sample('edge').path, 60);
    expect(s.lapCount).toBe(1);
    expect(s.events.some((e) => e.kind === 'gate-reverse' || e.kind === 'gate-skip')).toBe(false);
  });
});

describe('成绩与显示帧率无关', () => {
  const hzList = [240, 120, 60, 30, 24, 12];
  const baselines = hzList.map((hz) => ({ hz, s: runPath(sample('valid').path, hz) }));
  const ref = baselines.find((b) => b.hz === 240)!.s.laps[0];

  for (const { hz, s } of baselines) {
    it(`valid 在 ${hz}Hz 下圈速与 240Hz 基准一致（sub-frame 插值）`, () => {
      expect(s.lapCount).toBe(1);
      expect(s.laps[0].total).toBeCloseTo(ref.total, 6);
      for (let g = 0; g < 4; g++) {
        expect(s.laps[0].gateTimes[g]).toBeCloseTo(ref.gateTimes[g], 6);
      }
    });
  }

  it('不规则掉帧步长（1/120, 1/30, 1/15…）得到同一圈速', () => {
    const pattern = [1 / 120, 1 / 30, 1 / 15, 1 / 60, 1 / 45];
    const s = runPathIrregular(sample('valid').path, pattern);
    expect(s.lapCount).toBe(1);
    expect(s.laps[0].total).toBeCloseTo(ref.total, 5);
    for (let g = 0; g < 4; g++) {
      expect(s.laps[0].gateTimes[g]).toBeCloseTo(ref.gateTimes[g], 5);
    }
  });

  it('贴边样例在各帧率下圈速一致', () => {
    const fast = runPath(sample('edge').path, 240).laps[0].total;
    for (const hz of [60, 24, 12]) {
      expect(runPath(sample('edge').path, hz).laps[0].total).toBeCloseTo(fast, 6);
    }
  });
});

describe('逆行 / 跳关 / 重叠的解释性事件', () => {
  it('reverse 样例：起步后反向穿 G0，判逆行并作废', () => {
    const s = runPath(sample('reverse').path, 120);
    expect(s.lapCount).toBe(0);
    const rev = s.events.find((e) => e.kind === 'gate-reverse');
    expect(rev).toBeDefined();
    expect(rev!.gate).toBe(0);
    expect(rev!.forward).toBe(false);
    expect(s.mode).toBe('invalid');
    expect(rev!.message).toContain('逆行');
  });

  it('cut 横穿样例：跳过 G2 先碰 G3，判跳关并作废', () => {
    const s = runPath(sample('cut').path, 120);
    expect(s.lapCount).toBe(0);
    const skip = s.events.find((e) => e.kind === 'gate-skip');
    expect(skip).toBeDefined();
    expect(skip!.gate).toBe(3);
    expect(s.mode).toBe('invalid');
    expect(skip!.message).toContain('跳关');
  });
  it('overlap 样例：沿闸门共线滑行只记 overlap，不产生通过/圈速', () => {
    const s = runPath(sample('overlap').path, 120);
    const overlaps = s.events.filter((e) => e.kind === 'gate-overlap');
    expect(overlaps.length).toBeGreaterThan(0);
    expect(overlaps.every((e) => e.gate === 0)).toBe(true);
    expect(s.events.filter((e) => e.kind === 'gate-hit')).toHaveLength(0);
    expect(s.lapCount).toBe(0);
    expect(overlaps[0].message).toContain('共线重叠');
  });

  it('未起步时正向穿过非 G0 闸门记 gate-ignored', () => {
    // G1 是底直道上的竖直闸门（通行切线朝左），从右侧向左侧横穿且不经过 G0
    const g1 = track.gates[1];
    const path = new Path(
      withAutoAngles([
        { t: 0, pos: v(g1.center.x + 200, g1.center.y) },
        { t: 1, pos: v(g1.center.x - 200, g1.center.y) },
      ]),
    );
    const s = runPath(path, 60);
    expect(s.events.some((e) => e.kind === 'gate-ignored' && e.gate === 1)).toBe(true);
    expect(s.lapCount).toBe(0);
  });
});

describe('高速跨闸：扫掠线段与 sub-frame 触发时刻', () => {
  it('highspeed 样例在 4Hz 大步长下四扇闸门全部捕获，且各自有独立 sub-frame 时刻', () => {
    const s = runPath(sample('highspeed').path, 4);
    expect(s.lapCount).toBe(1);
    const g1 = s.events.find((e) => e.gate === 1 && e.kind === 'gate-hit')!;
    const g2 = s.events.find((e) => e.gate === 2 && e.kind === 'gate-hit')!;
    expect(g1).toBeDefined();
    expect(g2).toBeDefined();
    expect(g2.time).toBeGreaterThan(g1.time);
    // 关键帧之间的大跳跃在 240Hz 下会被拆成多帧；两种帧率成绩必须一致
    const fine = runPath(sample('highspeed').path, 240);
    expect(fine.lapCount).toBe(1);
    expect(s.laps[0].total).toBeCloseTo(fine.laps[0].total, 6);
    for (let g = 0; g < 4; g++) {
      expect(s.laps[0].gateTimes[g]).toBeCloseTo(fine.laps[0].gateTimes[g], 6);
    }
  });

  it('单帧同穿双闸：合成一条同帧扫过 G0、G1 的长位移，两个触发落在同一帧且时刻不同', () => {
    const g0 = track.gates[0];
    const g1 = track.gates[1];
    const p0 = v(g0.center.x + 80, g0.center.y - 40);
    const p1 = v(g1.center.x - 150, g1.center.y + 40);
    const session = new LapSession(track, p0);
    const events = session.advance(0.25, p1, 0);
    const hit0 = events.find((e) => e.gate === 0)!;
    const hit1 = events.find((e) => e.gate === 1)!;
    expect(hit0).toBeDefined();
    expect(hit1).toBeDefined();
    expect(hit1.time).toBeGreaterThan(hit0.time);
    expect(hit0.time).toBeGreaterThan(0);
    expect(hit1.time).toBeLessThan(0.25);
    // 同帧按位移参数 u 排序：G0 先处理（起步），G1 成为合法顺序通过
    expect(hit0.kind).toBe('gate-hit');
    expect(hit1.kind).toBe('gate-hit');
    expect(session.mode).toBe('running');
    expect(session.expected).toBe(2);
  });

  it('亚帧精确定时：触发时刻不吸附到帧边界，且随步长收敛到同一时刻', () => {
    // 沿真实跑道匀速接近 G0（单向、不回头），各帧率下的触发时刻应收敛
    const g0 = track.gates[0];
    const make = (hz: number) => {
      const path = new Path(
        withAutoAngles([
          { t: 0, pos: track.positionAt(g0.fraction - 0.05) },
          { t: 1, pos: track.positionAt(g0.fraction + 0.05) },
        ]),
      );
      return runPath(path, hz);
    };
    const ref = make(240).events.find((e) => e.gate === 0 && e.kind === 'gate-hit')!;
    for (const hz of [60, 24, 12, 4]) {
      const t = make(hz).events.find((e) => e.gate === 0 && e.kind === 'gate-hit')!.time;
      // 插值误差不超过半步长，且在 1e-4 秒量级上与高精度基准一致
      expect(Math.abs(t - ref.time)).toBeLessThan(1 / hz / 2 + 1e-9);
      expect(t).toBeCloseTo(ref.time, 4);
    }
  });
});

describe('暂停冻结计时', () => {
  it('暂停窗口内模拟时钟不前进，圈速与无暂停一致', () => {
    const clean = runPath(sample('valid').path, 120);
    // 窗口选在闸门之间的弧道段（valid 闸门约在 0.25/3.0/6.1/9.2s）
    const windows: Array<[number, number]> = [
      [1.0, 1.8],
      [4.0, 4.9],
      [7.0, 7.8],
    ];
    const paused = runPath(sample('valid').path, 120, windows);
    expect(paused.lapCount).toBe(1);
    expect(paused.laps[0].total).toBeCloseTo(clean.laps[0].total, 6);
    for (let g = 0; g < 4; g++) {
      expect(paused.laps[0].gateTimes[g]).toBeCloseTo(clean.laps[0].gateTimes[g], 6);
    }
    // 总墙钟 = 模拟时长 + 暂停时长；暂停总时长 2.5s
    const pauseTotal = windows.reduce((acc2, [a, b]) => acc2 + (b - a), 0);
    expect(pauseTotal).toBeCloseTo(2.5, 6);
    // 引擎时钟只在非暂停步推进：模拟部分的总时长与无暂停一致
    expect(paused.time).toBeCloseTo(clean.time, 6);
  });

  it('暂停瞬间调用 advance 不推进时钟、不改变位置', () => {
    const session = new LapSession(track);
    const before = { time: session.time, x: session.pos.x };
    session.pause();
    session.advance(0.5, v(session.pos.x + 100, session.pos.y), 0);
    expect(session.time).toBe(before.time);
    expect(session.pos.x).toBe(before.x);
    expect(session.events).toHaveLength(0);
  });
});

describe('幻影录制/回放', () => {
  it('离线录制有效圈生成幻影，按模拟时钟回放位姿', () => {
    const session = new LapSession(track);
    const { ghost, events } = recordLapOffline(session, sample('valid').path, 1 / 240);
    expect(events.some((e) => e.kind === 'lap')).toBe(true);
    expect(ghost.duration).toBeGreaterThan(0);
    expect(ghost.sampleAt(-0.01)).toBeNull();
    const at0 = ghost.sampleAt(0)!;
    expect(at0.pos).toBeDefined();
    const atEnd = ghost.sampleAt(ghost.duration)!;
    expect(atEnd.pos).toBeDefined();
    expect(ghost.sampleAt(ghost.duration + 1)).toBeNull();
  });

  it('Recorder 只在推进时记录帧，暂停不产生帧且时钟冻结', () => {
    const rec = new Recorder();
    const session = new LapSession(track);
    rec.start();
    session.advance(0.1, v(session.pos.x + 5, session.pos.y), 0);
    rec.capture(session);
    session.pause();
    session.advance(0.1, v(session.pos.x + 8, session.pos.y), 0); // 暂停步：整个模拟冻结，不录帧
    rec.capture(session);
    session.resume();
    session.advance(0.1, v(session.pos.x + 10, session.pos.y), 0);
    rec.capture(session);
    const frames = rec.stop();
    expect(frames).toHaveLength(2);
    // 两帧之间只隔一个非暂停步（0.1s），暂停的 0.1s 被排除
    expect(frames[1].t - frames[0].t).toBeCloseTo(0.1, 9);
    expect(session.time).toBeCloseTo(0.2, 9);
    const ghost = new Ghost(frames, 0);
    expect(ghost.sampleAt(0.05)).toBeDefined();
  });
});
