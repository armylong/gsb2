"""自生成三组短音（同相、反相、中侧内容不同）并写入 wav，不使用附件。

用法：
    python scripts/make_test_signals.py [输出目录]
默认输出到 ./test_signals/。另生成一个单声道文件用于提示逻辑验证。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import soundfile as sf  # noqa: E402

from mstool.audio_engine import (  # noqa: E402
    make_antiphase_signal,
    make_distinct_ms_signal,
    make_in_phase_signal,
    make_mono_signal,
)

SR = 48000


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("test_signals")
    out_dir.mkdir(parents=True, exist_ok=True)
    jobs = [
        ("in_phase.wav", make_in_phase_signal(SR), "PCM_16"),
        ("antiphase.wav", make_antiphase_signal(SR), "PCM_16"),
        ("distinct_ms.wav", make_distinct_ms_signal(SR), "PCM_16"),
        ("mono.wav", make_mono_signal(SR), "PCM_16"),
    ]
    for name, sig, subtype in jobs:
        path = out_dir / name
        sf.write(str(path), sig, SR, subtype=subtype)
        print(f"写入 {path}  形状={sig.shape}  时长={sig.shape[0] / SR:.2f}s")


if __name__ == "__main__":
    main()
