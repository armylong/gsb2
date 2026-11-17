"""本地生成测试样例（无需联网、无需账号）：

  samples/narration.wav   单声道 44.1kHz 旁白（macOS `say` 合成中文语音，
                          含短停顿与长空白；无 say 时退化为节奏蜂鸣并告警）
  samples/music.wav       立体声 44.1kHz 测试音乐（比旁白长，验证截断）
  samples/known_segments.json  已知语音区间，供核对检测结果

用法：python3 make_samples.py [输出目录]
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np

import duckcore as dc

SR = 44100

# (句子, 起始秒)。句间 0.4s 短停顿（应被合并保持压低），
# 第3句前有 3.0s 长空白（应恢复），结尾句子说完即结束（验证末尾处理）。
SCRIPT = [
    ("大家好,欢迎收看本期短片。", 0.8),
    ("今天我们来介绍自动闪避工具。", None),   # 接上一句 +0.4s
    ("它可以自动压低背景音乐。", None),       # 接上一句 +0.4s
    ("即使长时间没有说话,音乐也会自然恢复。", None),  # 前留 3.0s 长空白
    ("最后,感谢你的观看。", None),            # 接上一句 +0.4s
]
SHORT_PAUSE = 0.4
LONG_GAP_BEFORE = 3   # 第几句(0基)之前插入长空白
LONG_GAP = 3.0
TAIL = 0.6            # 最后一句说完后留的尾巴


def synth_sentence_say(text, workdir):
    """用 macOS say 合成单句，返回 float32 单声道 @SR。失败返回 None。"""
    if not shutil.which('say'):
        return None
    wav = os.path.join(workdir, 's.wav')
    for voice in ('Meijia', 'Tingting', 'Sinji', 'Reed', None):
        cmd = ['say']
        if voice:
            cmd += ['-v', voice]
        cmd += ['-o', wav, '--data-format=LEI16@44100', text]
        r = subprocess.run(cmd, capture_output=True)
        if r.returncode == 0 and os.path.exists(wav) and os.path.getsize(wav) > 1000:
            x, sr = dc.load_wav(wav)
            x = dc.to_mono(x)
            if sr != SR:
                x = dc.resample_linear(x, sr, SR)
            return x.astype(np.float32)
    return None


def synth_sentence_beep(text, dur_hint=None):
    """退化方案：按字数生成节奏蜂鸣（不可懂，仅保证区间已知）。"""
    n_chars = max(2, len(text))
    dur = dur_hint or n_chars * 0.22
    t = np.arange(int(SR * dur)) / SR
    f0 = 220 + 60 * np.sin(2 * np.pi * 3 * t)
    env = 0.5 + 0.5 * np.sin(2 * np.pi * (n_chars / dur) * t) ** 2
    x = 0.5 * env * np.sin(2 * np.pi * f0 * t)
    return x.astype(np.float32)


def build_narration():
    sentences = []
    say_ok = True
    with tempfile.TemporaryDirectory() as wd:
        for text, _ in SCRIPT:
            x = synth_sentence_say(text, wd)
            if x is None:
                say_ok = False
                x = synth_sentence_beep(text)
            sentences.append(x)
            # 去掉 say 输出首尾静音，便于精确摆放
    if not say_ok:
        print('警告: 未找到可用的 say 语音，旁白为节奏蜂鸣（区间仍已知）。')

    # 计算每句起点
    starts = []
    cursor = SCRIPT[0][1]
    for i, x in enumerate(sentences):
        if i == LONG_GAP_BEFORE:
            cursor += LONG_GAP
        starts.append(cursor)
        cursor += len(x) / SR + SHORT_PAUSE

    total = cursor - SHORT_PAUSE + TAIL
    n = int(round(total * SR))
    out = np.zeros(n, dtype=np.float32)
    known = []
    for x, st in zip(sentences, starts):
        i0 = int(round(st * SR))
        out[i0:i0 + len(x)] += x
        known.append([round(st, 3), round(st + len(x) / SR, 3)])
    out *= 0.9 / max(1e-6, np.max(np.abs(out)))
    return out.astype(np.float32), known


def build_music(dur):
    """立体声测试音乐：和弦垫 + 贝斯 + 琶音，左右声道内容不同。"""
    t = np.arange(int(SR * dur)) / SR
    bpm = 96
    beat = 60.0 / bpm
    chords = [(220.0, 277.18, 329.63), (174.61, 220.0, 261.63),
              (196.0, 246.94, 293.66), (164.81, 196.0, 246.94)]
    bar = beat * 4
    left = np.zeros_like(t)
    right = np.zeros_like(t)
    n_bars = int(np.ceil(dur / bar))
    for ci in range(n_bars):
        chord = chords[ci % len(chords)]
        seg = (t >= ci * bar) & (t < (ci + 1) * bar)
        if not seg.any():
            continue
        tt = t[seg] - ci * bar
        env = np.minimum(1, tt / 0.05) * np.minimum(1, np.maximum(0, bar - tt) / 0.3)
        for k, f in enumerate(chord):
            det = 1.0 + (0.0015 if k % 2 else -0.0015)
            left[seg] += 0.10 * env * np.sin(2 * np.pi * f * tt + k)
            right[seg] += 0.10 * env * np.sin(2 * np.pi * f * det * tt + k * 0.7)
    # 贝斯：每拍
    for b in range(int(dur / beat) + 1):
        seg = (t >= b * beat) & (t < b * beat + beat * 0.9)
        if not seg.any():
            continue
        tt = t[seg] - b * beat
        env = np.exp(-tt * 4)
        left[seg] += 0.16 * env * np.sin(2 * np.pi * 55 * tt)
        right[seg] += 0.16 * env * np.sin(2 * np.pi * 55.3 * tt)
    # 琶音：偏右
    arp_f = [440, 554.37, 659.25, 880]
    for k in range(int(dur / (beat / 2)) + 1):
        seg = (t >= k * beat / 2) & (t < k * beat / 2 + 0.18)
        if not seg.any():
            continue
        tt = t[seg] - k * beat / 2
        env = np.exp(-tt * 12)
        f = arp_f[k % 4]
        left[seg] += 0.05 * env * np.sin(2 * np.pi * f * tt)
        right[seg] += 0.12 * env * np.sin(2 * np.pi * f * tt)
    music = np.stack([left, right], axis=1)
    music *= 0.55 / max(1e-6, np.max(np.abs(music)))
    return music.astype(np.float32)


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else 'samples'
    os.makedirs(outdir, exist_ok=True)
    narration, known = build_narration()
    dur = len(narration) / SR
    music = build_music(dur + 5.0)  # 音乐比旁白长 5 秒，验证截断

    dc.write_wav(os.path.join(outdir, 'narration.wav'), narration, SR)
    dc.write_wav(os.path.join(outdir, 'music.wav'), music, SR)
    with open(os.path.join(outdir, 'known_segments.json'), 'w') as f:
        json.dump(dict(sr=SR, duration=round(dur, 3), segments=known), f,
                  ensure_ascii=False, indent=2)
    print(f'旁白 {dur:.2f}s -> {outdir}/narration.wav (单声道)')
    print(f'音乐 {dur + 5:.2f}s -> {outdir}/music.wav (立体声)')
    print(f'已知语音区间 {len(known)} 段 -> {outdir}/known_segments.json')
    for s, e in known:
        print(f'  {s:7.3f} - {e:7.3f}')


if __name__ == '__main__':
    main()
