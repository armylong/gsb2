"""生成已知内容的测试音 WAV(48kHz/16bit),供界面试听与脚本验证。

test_6ch.wav(6 声道,2 秒):
  声道1: 440Hz 正弦,幅度 0.8
  声道2: 440Hz 正弦,幅度 0.8,与声道1 同相
  声道3: 440Hz 正弦,幅度 0.8,与声道1 反相
  声道4: 1000Hz 正弦,幅度 0.5
  声道5: 采样点 1000 处的脉冲,幅度 0.9
  声道6: 采样点 5000 处的脉冲,幅度 0.9(与声道5 错开)

test_3ch.wav(3 声道,1 秒):用于演示"按文件实际顺序标识声道"。
"""
import os

import numpy as np

import dsp

BASE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(BASE, "test_tones")


def _impulse(n, pos, amp):
    x = np.zeros(n)
    x[pos] = amp
    return x


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    sr = dsp.SAMPLE_RATE

    n = int(sr * 2.0)
    t = np.arange(n) / sr
    s = 0.8 * np.sin(2 * np.pi * 440.0 * t)
    chans = [
        s,
        s.copy(),                                   # 与声道1 同相
        -s,                                         # 与声道1 反相
        0.5 * np.sin(2 * np.pi * 1000.0 * t),
        _impulse(n, 1000, 0.9),
        _impulse(n, 5000, 0.9),
    ]
    p6 = os.path.join(OUT_DIR, "test_6ch.wav")
    dsp.write_wav(p6, np.stack(chans, axis=1))

    n3 = int(sr * 1.0)
    t3 = np.arange(n3) / sr
    chans3 = [
        0.6 * np.sin(2 * np.pi * 330.0 * t3),
        0.6 * np.sin(2 * np.pi * 660.0 * t3),
        _impulse(n3, 2000, 0.9),
    ]
    p3 = os.path.join(OUT_DIR, "test_3ch.wav")
    dsp.write_wav(p3, np.stack(chans3, axis=1))

    print(f"已生成 {p6} (6 声道, 2.0 秒)")
    print(f"已生成 {p3} (3 声道, 1.0 秒)")


if __name__ == "__main__":
    main()
