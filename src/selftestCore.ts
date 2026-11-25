import { xToTime, timeToX, clamp } from './domain/mapping';
import { ScrubPlanner } from './audio/scrubPlanner';
import { audioBufferToWav } from './audio/wav';

export interface SelfTestResult {
  name: string;
  ok: boolean;
  detail: string;
}

class AssertionError extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

function makeMockBuffer(): AudioBuffer {
  const channel = new Float32Array([0.25, -0.5]);
  return {
    length: 2,
    duration: 2 / 44100,
    sampleRate: 44100,
    numberOfChannels: 2,
    getChannelData: () => channel,
  } as unknown as AudioBuffer;
}

export async function runSelfTests(): Promise<SelfTestResult[]> {
  const results: SelfTestResult[] = [];
  const test = async (name: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
      results.push({ name, ok: true, detail: '通过' });
    } catch (error) {
      results.push({
        name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await test('坐标往返映射', () => {
    const width = 900;
    const duration = 8;
    for (const time of [0, 0.137, 1, 3.333, 7.999, 8]) {
      const x = timeToX(time, width, duration);
      const back = xToTime(x, width, duration);
      assert(Math.abs(back - clamp(time, 0, duration)) < 1e-9, `${time}s 往返后为 ${back}s`);
    }
    assert(xToTime(-50, width, duration) === 0, '左侧越界必须夹到 0');
    assert(xToTime(width + 80, width, duration) === duration, '右侧越界必须夹到结尾');
  });

  await test('往返拖听方向与镜像位置', () => {
    const duration = 8;
    const planner = new ScrubPlanner(0, 2, { durationSec: duration, observationSec: 0.32, sensitivity: 1 });
    let commands = planner.ingest(0.08, 2.5);
    const forward = commands.find((command) => command.type === 'start');
    assert(forward?.type === 'start' && forward.atom.direction === 1, '向右应产生正向声音');

    commands = planner.ingest(0.16, 2.0);
    const reverse = commands.find((command) => command.type === 'start');
    assert(reverse?.type === 'start', '反向应立即切断并起新声');
    assert(reverse.atom.direction === -1, '向左必须使用反向缓冲');
    assert(reverse.atom.sourceTime >= 2.0, '反向 atom 的 sourceTime 应是当前点右侧边');
    assert(reverse.atom.sourceTime - 2 < 0.08, '反向预卷必须很短且对应当前范围');
    planner.release(0.24);
    assert(planner.route.duration > 0, '路线时长应已记录');
  });

  await test('首尾边界与远跳不补播中间段', () => {
    const duration = 8;
    const planner = new ScrubPlanner(0, 0.15, { durationSec: duration, observationSec: 0.32, sensitivity: 1.4 });
    planner.ingest(0.08, duration - 0.15);
    const jump = planner.route.atoms.at(-1);
    assert(jump?.jumped === true, '远距离跳跃应标记为 jump');
    assert(jump.sourceTime > duration - 0.3, '远跳后只应在落点附近发声');

    planner.ingest(0.16, duration + 999);
    const endAtom = planner.route.atoms.at(-1);
    assert(endAtom, '右端应产生 atom');
    assert(endAtom.sourceTime <= duration && endAtom.sourceTime >= duration - 0.09, '右端应夹到文件尾');
    assert(endAtom.fadeOut > 0, '右端必须带平顺淡出');

    planner.ingest(0.24, -999);
    const startAtom = planner.route.atoms.at(-1);
    assert(startAtom, '左端应产生 atom');
    assert(startAtom.direction === -1, '从右端突然向左应反向');
    assert(startAtom.sourceTime <= 0.09, '左端应夹到文件头附近');

    planner.release(0.33);
    const coversSkippedGap = planner.route.atoms.some((atom) => {
      const span = atom.duration * atom.rate;
      return atom.direction === 1 && atom.sourceTime > 1 && atom.sourceTime + span < 5;
    });
    assert(!coversSkippedGap, '不能有 atom 去补播被跳过的数秒中间区间');
  });

  await test('停住/松开后 atom 不循环', () => {
    const planner = new ScrubPlanner(0, 1, { durationSec: 8, observationSec: 0.2, sensitivity: 1 });
    planner.ingest(0.05, 1.01);
    const firstCount = planner.route.atoms.length;
    for (let now = 0.1; now <= 1; now += 0.05) planner.ingest(now, 1.01);
    assert(planner.route.atoms.length === firstCount, '位置不变时不应持续创建新响点');
    assert(planner.release(1.05).length === 0, '观察片段自然结束后不应循环');

    const releasePlanner = new ScrubPlanner(0, 1, { durationSec: 8, observationSec: 0.4, sensitivity: 1 });
    releasePlanner.ingest(0.04, 1.02);
    const release = releasePlanner.release(0.09);
    assert(release.some((command) => command.type === 'stop'), '快速松开应发出 stop/fade 命令');
    assert(releasePlanner.release(0.2).length === 0, '释放后不能再次停止或重复播放');
  });

  await test('WAV 16-bit 编码头', async () => {
    const blob = audioBufferToWav(makeMockBuffer());
    assert(blob.type === 'audio/wav', 'Blob MIME 应为 audio/wav');
    const bytes = await blob.arrayBuffer();
    const view = new DataView(bytes);
    const read = (offset: number, length: number) =>
      String.fromCharCode(...new Uint8Array(bytes, offset, length));
    assert(read(0, 4) === 'RIFF' && read(8, 4) === 'WAVE', '缺少 RIFF/WAVE 标识');
    assert(view.getUint16(22, true) === 2, '应为双声道');
    assert(view.getUint32(24, true) === 44100, '采样率应为 44100');
    assert(view.getUint32(40, true) === 8, 'data chunk 应为 2 frames × 4 bytes');
    assert(bytes.byteLength === 52, 'WAV 总长度应为 44 + 8');
  });

  return results;
}
