"""命令行入口: 生成可复现样例 wav(+地面真值 JSON), 不启动 GUI。

用法: .venv/bin/python -m pitchcorrect.make_sample [输出目录]
"""
from __future__ import annotations

import os
import sys

from .sample import generate_sample


def main() -> int:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.getcwd(), "sample_output")
    os.makedirs(out_dir, exist_ok=True)
    wav_path = os.path.join(out_dir, "sample_stereo.wav")
    json_path = os.path.join(out_dir, "sample_groundtruth.json")
    truth = generate_sample(wav_path, json_path=json_path)
    print(f"已生成样例: {wav_path}")
    print(f"地面真值:   {json_path}")
    print(f"  采样率 {truth['sr']} Hz | 参考 {truth['f_nom']} Hz | "
          f"内容纯音 {truth['content_tone_hz']} Hz")
    print(f"  真实打点时刻(s): {truth['click_times_true_s']}")
    print(f"  通道: 0=内容, 1=参考")
    print(f"  掉块(真实时间 s): {truth['dropouts_true_s']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
