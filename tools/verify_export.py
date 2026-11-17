#!/usr/bin/env python3
"""verify_export.py — 独立回读核对工具（纯标准库）。

用法：
  python3 -I tools/verify_export.py 导出.loop.wav 区间说明.loop.json

检查项：
  1. WAV 可解析，采样率/声道/位深与说明文件一致；
  2. 帧数 == selectedLengthFrames - crossfadeFrames，循环时长正确；
  3. 循环起点、终点在源文件范围内且为合法区间；
  4. 回读接缝跳变（末帧与首帧之差）每声道不超过阈值；
  5. 双声道长度严格一致（同步边界）。
全部通过退出码 0，任一失败退出码 1 并打印原因。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wav_io import read_wav, WavError  # noqa: E402
from loop_core import loop_seam_jump  # noqa: E402

SEAM_LIMIT = 0.02


def main():
    if len(sys.argv) != 3:
        print("用法: python3 -I tools/verify_export.py <导出wav> <说明json>")
        return 2
    wav_path, json_path = sys.argv[1], sys.argv[2]
    failures = []

    try:
        audio = read_wav(wav_path)
    except WavError as exc:
        print("失败: %s" % exc)
        return 1

    try:
        with open(json_path, "r", encoding="utf-8") as f:
            sc = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print("失败: 无法读取区间说明 JSON：%s" % exc)
        return 1

    loop = sc.get("loop", {})

    def check(name, cond, detail):
        if cond:
            print("  ✓ %-28s %s" % (name, detail))
        else:
            print("  ✗ %-28s %s" % (name, detail))
            failures.append(name)

    print("核对 %s vs %s" % (os.path.basename(wav_path), os.path.basename(json_path)))
    check("采样率", audio["sample_rate"] == loop.get("exportedSampleRate"),
          "%d Hz（说明 %s）" % (audio["sample_rate"], loop.get("exportedSampleRate")))
    check("声道数", audio["channels"] == loop.get("exportedChannels"),
          "%d（说明 %s）" % (audio["channels"], loop.get("exportedChannels")))
    check("位深/编码",
          audio["bit_depth"] == loop.get("exportedBitDepth") and audio["encoding"] == loop.get("exportedEncoding"),
          "%d-bit %s" % (audio["bit_depth"], audio["encoding"]))

    expected_frames = loop.get("selectedLengthFrames", 0) - loop.get("crossfadeFrames", 0)
    check("帧数 = L - F", audio["frame_count"] == expected_frames,
          "实际 %d / 期望 %d" % (audio["frame_count"], expected_frames))

    dur_ms = audio["frame_count"] / audio["sample_rate"] * 1000.0
    check("循环时长", abs(dur_ms - loop.get("exportedDurationMs", -1)) < 1e-6,
          "%.4f ms（说明 %.4f ms）" % (dur_ms, loop.get("exportedDurationMs", -1)))

    sf, ef = loop.get("startFrame"), loop.get("endFrame")
    check("区间边界合法",
          isinstance(sf, int) and isinstance(ef, int) and sf >= 0
          and ef <= sc.get("sourceTotalFrames", 0) and ef - sf >= 2,
          "start=%s end=%s（源共 %s 帧）" % (sf, ef, sc.get("sourceTotalFrames")))

    ch_lens = {len(ch) for ch in audio["data"]}
    check("双声道长度一致（同步）", len(ch_lens) == 1, str(ch_lens))

    jumps = loop_seam_jump(audio["data"])
    worst = max(jumps)
    labels = ["L", "R"] if audio["channels"] == 2 else ["M"]
    check("接缝跳变 <= %.0e" % SEAM_LIMIT, worst <= SEAM_LIMIT,
          " ".join("%s=%.3e" % (labels[i], v) for i, v in enumerate(jumps)))

    # 非空与长度错误的硬性保护
    check("非空音频", audio["frame_count"] > 0, "%d 帧" % audio["frame_count"])

    if failures:
        print("\n结论: 失败 %d 项：%s" % (len(failures), ", ".join(failures)))
        return 1
    print("\n结论: 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
