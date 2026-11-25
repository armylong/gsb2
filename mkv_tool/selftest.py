from __future__ import annotations

import argparse
from pathlib import Path

from .audio import dominant_frequency, extract_mono_pcm_wav
from .edits import TrackEditSession
from .exporter import export_mkv
from .media import probe_file
from .sample import generate_sample


def run_selfcheck(out_dir: Path) -> list[str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    sample = out_dir / "multitrack.mkv"
    edited = out_dir / "remove-first-audio.mkv"
    generate_sample(sample)

    info = probe_file(sample)
    session = TrackEditSession(info)
    session.set_included(1, False)
    session.set_default(2, True)
    report = export_mkv(session.build_plan(edited, overwrite=True))
    if not report.ok:
        raise RuntimeError("导出复核未通过：\n" + "\n".join(report.summary_lines()))

    reopened = probe_file(edited)
    if len(reopened.audios) != 1:
        raise AssertionError(f"应当只剩 1 条音轨，实际 {len(reopened.audios)}")
    if reopened.streams[1].codec_type != "audio":
        raise AssertionError("输出 #1 不是音频，可能错拿成了字幕/其他流")
    if reopened.streams[2].codec_type != "subtitle":
        raise AssertionError("输出 #2 应当是第一条字幕")

    wav = out_dir / "retained-audio.wav"
    extract_mono_pcm_wav(edited, reopened.audios[0].index, wav)
    frequency = dominant_frequency(wav)
    if abs(frequency - 880.0) >= 25.0:
        raise AssertionError(f"保留音轨主频应为约 880 Hz，实际 {frequency:.1f} Hz")
    if abs(frequency - 440.0) <= 100.0:
        raise AssertionError("保留音轨仍像 440 Hz，第一条可能没有被正确移除")

    offset_sample = out_dir / "multitrack.offsets.mkv"
    generate_sample(offset_sample, offset_demo=True)
    offsets = probe_file(offset_sample)
    late = offsets.relative_offset(offsets.get(1))
    early = offsets.relative_offset(offsets.get(2))
    if late is None or early is None or not (late > 0.2 and early < -0.1):
        raise AssertionError(f"偏移样片方向不对：late={late}, early={early}")

    return [
        f"样片：{sample}",
        f"移除第一条音轨后的成品：{edited}",
        f"输出 #1 种类：{reopened.streams[1].codec_type}/{reopened.streams[1].codec_name}",
        f"保留音轨主频：{frequency:.1f} Hz（预期约 880 Hz）",
        f"偏移样片：{offset_sample}（440 轨相对视频 {late:+.3f}s，880 轨 {early:+.3f}s）",
        "自检通过：移除 #1 后保留的是源 #2/880 Hz 音轨，没有错拿字幕。",
    ]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="生成样片并验证音轨映射/移除结果")
    parser.add_argument(
        "--out-dir",
        default="samples/selfcheck",
        help="保留样片和验证成品的目录（默认 samples/selfcheck）",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        lines = run_selfcheck(Path(args.out_dir))
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        print(f"自检失败：{exc}")
        return 1
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
