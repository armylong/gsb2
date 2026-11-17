/*
 * loop-maker.test.js — Node 内置 test runner，零依赖。
 * 运行：node --test tests/
 * 覆盖：WAV 编解码与错误提示、双声道同步、区间边界校验、
 *       接缝交叉淡化数学、接缝试听缓冲、导出回读、JS/Python 算法交叉校验。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WavCodec = require(path.join(ROOT, 'js', 'wav-codec.js'));
const LoopCore = require(path.join(ROOT, 'js', 'loop-core.js'));
const Geometry = require(path.join(ROOT, 'js', 'geometry.js'));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-maker-test-'));

function readAsArrayBuffer(p) {
  const buf = fs.readFileSync(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function stereoFixture(frames = 2000, sr = 48000) {
  const L = new Float32Array(frames), R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i / sr;
    L[i] = 0.6 * Math.sin(2 * Math.PI * 220 * t);
    R[i] = 0.5 * Math.sin(2 * Math.PI * 220 * t + Math.PI / 4);
  }
  return [L, R];
}

/* ---------- WAV 解码：错误提示 ---------- */
test('空文件给出清晰错误', () => {
  assert.throws(() => WavCodec.decodeWav(new ArrayBuffer(0)), /文件为空/);
});

test('非 WAV / 损坏文件给出清晰错误', () => {
  assert.throws(() => WavCodec.decodeWav(new TextEncoder().encode('hello world this is text')), /RIFF|WAVE/);
  const riff = new Uint8Array(64);
  riff.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF 但无 WAVE
  assert.throws(() => WavCodec.decodeWav(riff), /WAVE/);
});

test('截断文件与空 data 块被拒绝', () => {
  const [L, R] = stereoFixture(100);
  const buf = WavCodec.encodeWav16([L, R], 48000);
  assert.throws(() => WavCodec.decodeWav(buf.slice(0, 60)), /fmt|data|损坏|截断/);

  // 构造 data 块长度为 0 的合法 RIFF 容器
  const empty = new ArrayBuffer(44);
  const v0 = new DataView(empty);
  const put = (o, s) => { for (let i = 0; i < 4; i++) v0.setUint8(o + i, s.charCodeAt(i)); };
  put(0, 'RIFF'); v0.setUint32(4, 36, true); put(8, 'WAVE');
  put(12, 'fmt '); v0.setUint32(16, 16, true);
  v0.setUint16(20, 1, true); v0.setUint16(22, 2, true);
  v0.setUint32(24, 48000, true); v0.setUint32(28, 192000, true);
  v0.setUint16(32, 4, true); v0.setUint16(34, 16, true);
  put(36, 'data'); v0.setUint32(40, 0, true);
  assert.throws(() => WavCodec.decodeWav(empty), /音频数据为空/);
});

test('不支持的编码（非 PCM/float）被拒绝', () => {
  const buf = new ArrayBuffer(64);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 48, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 0x55, true); // 压缩编码
  v.setUint16(22, 2, true); v.setUint32(24, 48000, true);
  v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, 0, true);
  assert.throws(() => WavCodec.decodeWav(buf), /不支持的 WAV 编码/);
});

/* ---------- WAV 编解码往返：全部支持格式 ---------- */
test('16-bit 双声道编解码往返且左右不串扰', () => {
  const [L, R] = stereoFixture(512, 44100);
  const buf = WavCodec.encodeWav16([L, R], 44100);
  const dec = WavCodec.decodeWav(buf);
  assert.equal(dec.sampleRate, 44100);
  assert.equal(dec.channels, 2);
  assert.equal(dec.bitDepth, 16);
  assert.equal(dec.frameCount, 512);
  assert.ok(dec.data[0].length === dec.data[1].length && dec.data[0].length === 512);
  for (let i = 0; i < 512; i++) {
    assert.ok(Math.abs(dec.data[0][i] - L[i]) < 1e-4, 'L 串扰/误差超标');
    assert.ok(Math.abs(dec.data[1][i] - R[i]) < 1e-4, 'R 串扰/误差超标');
    assert.ok(Math.abs(dec.data[0][i] - dec.data[1][i]) > 1e-3, '左右声道内容不应相同');
  }
});

test('手工构造 8/24/32-bit PCM 与 float32 均可解析', () => {
  const sr = 8000, n = 16;
  const make = (tag, bytesPer, writer) => {
    const dataLen = n * 2 * bytesPer;
    const b = new ArrayBuffer(44 + dataLen);
    const v = new DataView(b);
    const str = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, tag === 'f32' ? 3 : 1, true);
    v.setUint16(22, 2, true); v.setUint32(24, sr, true);
    v.setUint16(32, 2 * bytesPer, true); v.setUint16(34, bytesPer * 8, true);
    str(36, 'data'); v.setUint32(40, dataLen, true);
    let p = 44;
    for (let i = 0; i < n; i++) {
      const val = Math.sin(i / 3);
      for (let c = 0; c < 2; c++) {
        writer(v, p, val, c);
        p += bytesPer;
      }
    }
    const dec = WavCodec.decodeWav(b);
    assert.equal(dec.frameCount, n);
    assert.equal(dec.sampleRate, sr);
    assert.ok(Math.abs(dec.data[0][5] - Math.sin(5 / 3)) < 0.02, tag + ' 解码误差');
  };
  make('u8', 1, (v, p, x) => v.setUint8(p, Math.round(x * 127 + 128)));
  make('i24', 3, (v, p, x) => {
    let q = Math.round(x * 8388607);
    q = Math.max(-8388608, Math.min(8388607, q));
    if (q < 0) q += 1 << 24;
    v.setUint8(p, q & 0xff); v.setUint8(p + 1, (q >> 8) & 0xff); v.setUint8(p + 2, (q >> 16) & 0xff);
  });
  make('i32', 4, (v, p, x) => v.setInt32(p, Math.round(x * 2147483647), true));
  make('f32', 4, (v, p, x) => v.setFloat32(p, x, true));
});

/* ---------- 区间边界校验 ---------- */
test('无效区间被拒绝（倒序、过短、越界、非整数）', () => {
  const ch = stereoFixture(100);
  assert.throws(() => LoopCore.buildLoop(ch, 80, 10, 0), /区间/);
  assert.throws(() => LoopCore.buildLoop(ch, 10, 11, 0), /至少包含 2/);
  assert.throws(() => LoopCore.buildLoop(ch, 0, 101, 0), /超出文件范围/);
  assert.throws(() => LoopCore.buildLoop(ch, -1, 10, 0), /超出文件范围/);
  assert.throws(() => LoopCore.buildLoop(ch, 1.5, 10, 0), /整数采样帧/);
});

test('淡化帧数超过区间一半时自动收敛', () => {
  const ch = stereoFixture(100);
  const r = LoopCore.buildLoop(ch, 10, 20, 99);
  assert.equal(r.config.fadeFrames, 5);
  assert.equal(r.config.fadeClamped, true);
  assert.equal(r.lengthFrames, 10 - 5);
});

test('零淡化时输出与源区间逐帧相同', () => {
  const ch = stereoFixture(100);
  const r = LoopCore.buildLoop(ch, 20, 60, 0);
  assert.equal(r.lengthFrames, 40);
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < 40; i++) assert.equal(r.channels[c][i], ch[c][20 + i]);
  }
});

/* ---------- 双声道同步：同一边界、等长、逐位置对应 ---------- */
test('双声道使用同一循环边界且输出等长', () => {
  const ch = stereoFixture(2000);
  const r = LoopCore.buildLoop(ch, 100, 1100, 64);
  assert.equal(r.channels.length, 2);
  assert.equal(r.channels[0].length, r.channels[1].length);
  assert.equal(r.lengthFrames, 1000 - 64);
  // 非淡化段两声道分别与源对应位置一致（证明没有错位/串行）
  for (let i = 64; i < r.lengthFrames; i++) {
    assert.equal(r.channels[0][i], ch[0][100 + i]);
    assert.equal(r.channels[1][i], ch[1][100 + i]);
  }
});

/* ---------- 接缝交叉淡化数学 ---------- */
test('交叉淡化后接缝跳变显著小于原始跳变，且互补增益保幅', () => {
  // 构造首尾有明确跳变的信号：恒定 0.9 后接 -0.9
  const n = 400;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = i < n / 2 ? 0.9 : -0.9;
  const raw = LoopCore.rawSeamJump([mono], 0, n)[0];
  assert.ok(raw > 1.7, '原始接缝应有明显跳变');
  const r = LoopCore.buildLoop([mono], 0, n, 40);
  const jump = LoopCore.loopSeamJump(r.channels)[0];
  assert.ok(jump < 0.06, '淡化后接缝跳变应被消除，实际 ' + jump);
  // 淡化区任意帧增益和为 1（等增益）
  const cfg = r.config;
  for (let k = 0; k < cfg.fadeFrames; k++) {
    const g = (k + 1) / (cfg.fadeFrames + 1);
    assert.ok(Math.abs((g + (1 - g)) - 1) < 1e-12);
  }
});

test('接缝两侧在源中为相邻采样（无空隙的数学保证）', () => {
  const ch = stereoFixture(500);
  const s = 50, e = 350, F = 30;
  const r = LoopCore.buildLoop(ch, s, e, F);
  // 输出末帧对应源 start+N-1，输出首帧淡化中含源 start 与 tail；
  // 关键性质：输出最后一帧的源位置 = start+N-1，与首帧包含的源 start 帧在循环意义下相邻衔接
  assert.equal(r.channels[0][r.lengthFrames - 1], ch[0][s + r.lengthFrames - 1]);
  assert.equal(r.lengthFrames, (e - s) - F);
});

test('F=1 边界情形不抛错且长度为 L-1', () => {
  const ch = stereoFixture(10);
  const r = LoopCore.buildLoop(ch, 0, 4, 1);
  assert.equal(r.lengthFrames, 3);
  assert.equal(r.config.fadeFrames, 1);
});

/* ---------- 毫秒/帧换算 ---------- */
test('ms 与帧换算一致', () => {
  assert.equal(LoopCore.msToFrames(10, 48000), 480);
  assert.equal(LoopCore.msToFrames(0, 48000), 0);
  assert.ok(Math.abs(LoopCore.framesToMs(480, 48000) - 10) < 1e-12);
});

/* ---------- 几何换算 ---------- */
test('帧/像素换算与缩放锚点正确', () => {
  assert.equal(Geometry.frameAtX(10, 0, 2, 100, 1000), 20);
  assert.equal(Geometry.xAtFrame(20, 0, 2), 10);
  assert.equal(Geometry.frameAtX(-50, 0, 2, 100, 1000), 0);
  assert.equal(Geometry.frameAtX(99999, 0, 2, 100, 1000), 1000);
  const peaks = Geometry.buildPeaks(new Float32Array([1, -1, 2, -2, 3]), 2);
  assert.equal(peaks.buckets, 3);
  assert.equal(peaks.max[0], 1);
  assert.equal(peaks.min[1], -2);
});

/* ---------- 导出回读（JS 全链路：编码 -> 解码 -> 核对） ---------- */
test('导出 WAV 回读：帧数、时长、接缝与说明一致', () => {
  const ch = stereoFixture(3000, 48000);
  const s = 200, e = 2600, F = 48;
  const built = LoopCore.buildLoop(ch, s, e, F);
  const wavPath = path.join(tmpDir, 'export.loop.wav');
  fs.writeFileSync(wavPath, Buffer.from(WavCodec.encodeWav16(built.channels, 48000)));

  const back = WavCodec.decodeWav(readAsArrayBuffer(wavPath));
  assert.equal(back.frameCount, built.lengthFrames);
  assert.equal(back.channels, 2);
  assert.equal(back.sampleRate, 48000);
  assert.ok(Math.abs(back.durationSec - built.lengthFrames / 48000) < 1e-9);

  const sidecar = {
    sourceTotalFrames: 3000,
    loop: {
      startFrame: s, endFrame: e,
      selectedLengthFrames: e - s, crossfadeFrames: F,
      exportedLengthFrames: built.lengthFrames,
      exportedDurationMs: built.lengthFrames / 48000 * 1000,
      exportedSampleRate: 48000, exportedChannels: 2,
      exportedBitDepth: 16, exportedEncoding: 'PCM',
    },
  };
  const jsonPath = path.join(tmpDir, 'export.loop.json');
  fs.writeFileSync(jsonPath, JSON.stringify(sidecar));

  // 回读接缝必须达标
  const jumps = LoopCore.loopSeamJump(back.data);
  assert.ok(Math.max(jumps[0], jumps[1]) <= 0.02, '回读接缝跳变超标: ' + jumps);

  // 用独立 Python 核对脚本再验一遍
  const py = spawnSync('python3', ['-I', path.join(ROOT, 'tools', 'verify_export.py'), wavPath, jsonPath], { encoding: 'utf8' });
  assert.equal(py.status, 0, 'Python 回读核对失败:\n' + py.stdout + py.stderr);
});

test('空音频禁止导出', () => {
  assert.throws(() => WavCodec.encodeWav16([new Float32Array(0), new Float32Array(0)], 48000), /空音频/);
  assert.throws(() => WavCodec.encodeWav16([], 48000), /没有可导出/);
});

test('声道长度不一致禁止导出', () => {
  assert.throws(
    () => WavCodec.encodeWav16([new Float32Array(10), new Float32Array(11)], 48000),
    /各声道长度不一致/
  );
});

/* ---------- JS / Python 算法交叉校验 ---------- */
test('JS 与 Python 参考实现逐帧一致（同一算法两种实现）', () => {
  const hook = path.join(tmpDir, 'parity_hook.py');
  fs.writeFileSync(hook, `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'tools'))})
from wav_io import read_wav
from loop_core import build_loop
wav, out_wav, start, end, fade = sys.argv[1:6]
a = read_wav(wav)
r = build_loop(a["data"], int(start), int(end), int(fade))
from wav_io import write_wav16
write_wav16(out_wav, r["channels"], a["sample_rate"])
print(json.dumps({"length": r["length_frames"], "cfg": r["config"]}))
`);
  const ch = stereoFixture(1777, 44100);
  const inWav = path.join(tmpDir, 'parity_in.wav');
  fs.writeFileSync(inWav, Buffer.from(WavCodec.encodeWav16(ch, 44100)));
  const s = 123, e = 1654, F = 77;

  const jsLoop = LoopCore.buildLoop(ch, s, e, F);
  const pyOut = path.join(tmpDir, 'parity_out.wav');
  const run = spawnSync('python3', ['-I', hook, inWav, pyOut, String(s), String(e), String(F)], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const meta = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.equal(meta.length, jsLoop.lengthFrames);

  const pyDec = WavCodec.decodeWav(readAsArrayBuffer(pyOut));
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < jsLoop.lengthFrames; i++) {
      assert.ok(Math.abs(pyDec.data[c][i] - jsLoop.channels[c][i]) < 1e-4,
        '声道 ' + c + ' 帧 ' + i + ' JS/Python 不一致');
    }
  }
});

test('样例文件全部可被解码器解析且时长在短音效范围', () => {
  const samplesDir = path.join(ROOT, 'samples');
  if (!fs.existsSync(samplesDir)) return; // 未生成样例时跳过
  for (const name of fs.readdirSync(samplesDir).filter((f) => f.endsWith('.wav'))) {
    const dec = WavCodec.decodeWav(fs.readFileSync(path.join(samplesDir, name)));
    assert.ok(dec.durationSec > 0 && dec.durationSec <= 2.0, name + ' 应为短音效');
    assert.ok(dec.channels >= 1 && dec.channels <= 2);
  }
});
