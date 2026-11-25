from __future__ import annotations

import argparse
import tempfile
from pathlib import Path

from .errors import SampleGenerationError, ffmpeg_path
from .runner import run_capture

_FORCED_SRT = """\
1
00:00:00,200 --> 00:00:01,000
[FORCED] Signs: 440 or 880?

2
00:00:01,200 --> 00:00:02,400
Forced subtitle second cue
"""

_ENGLISH_SRT = """\
1
00:00:00,250 --> 00:00:01,050
English full subtitle one

2
00:00:01,250 --> 00:00:02,500
English full subtitle two
"""

_CHINESE_SRT = """\
1
00:00:00,300 --> 00:00:01,100
中文字幕第一条

2
00:00:01,300 --> 00:00:02,600
中文字幕第二条
"""

_NOLANG_SRT = """\
1
00:00:00,350 --> 00:00:01,150
Untagged subtitle A

2
00:00:01,350 --> 00:00:02,650
Untagged subtitle B
"""


def _write_srt_files(directory: Path) -> list[Path]:
    files = []
    for name, content in (
        ("forced.srt", _FORCED_SRT),
        ("english.srt", _ENGLISH_SRT),
        ("chinese.srt", _CHINESE_SRT),
        ("nolang.srt", _NOLANG_SRT),
    ):
        path = directory / name
        path.write_text(content, encoding="utf-8")
        files.append(path)
    return files


def generate_sample(
    output: str | Path,
    *,
    duration: float = 3.0,
    offset_demo: bool = False,
    ffmpeg: str | Path | None = None,
) -> Path:
    """Generate a self-contained multi-audio/multi-subtitle MKV sample.

    Audio track 1 is a 440 Hz sine and track 2 an 880 Hz sine.  Tests can
    therefore prove that removing stream #1 leaves the 880 Hz stream, not a
    subtitle or another accidentally mapped stream.
    """
    exe = ffmpeg_path(ffmpeg)
    out = Path(output).expanduser().absolute()
    if out.is_dir() or output is None:
        out = out / ("multitrack.offsets.mkv" if offset_demo else "multitrack.mkv")
    if out.suffix.lower() != ".mkv":
        out = out.with_suffix(".mkv")
    out.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="mkvtool-sample-") as tmp:
        tmp_path = Path(tmp)
        forced, english, chinese, nolang = _write_srt_files(tmp_path)

        args: list[str] = [exe, "-hide_banner", "-loglevel", "error", "-y"]
        args.extend(
            [
                "-f",
                "lavfi",
                "-i",
                f"testsrc2=size=640x360:rate=25:duration={duration}",
            ]
        )

        # Relative to the video clock after FFmpeg's common zero shift, these
        # become +0.350 s and -0.150 s.
        if offset_demo:
            args.extend(["-itsoffset", "0.35"])
        args.extend(["-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}"])
        if offset_demo:
            args.extend(["-itsoffset", "-0.15"])
        args.extend(["-f", "lavfi", "-i", f"sine=frequency=880:duration={duration}"])

        for srt in (forced, english, chinese, nolang):
            args.extend(["-i", str(srt)])

        args.extend(
            [
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-map",
                "2:a:0",
                "-map",
                "3:s:0",
                "-map",
                "4:s:0",
                "-map",
                "5:s:0",
                "-map",
                "6:s:0",
                "-t",
                str(duration),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "96k",
                "-c:s",
                "subrip",
                "-metadata:s:v:0",
                "language=und",
                "-metadata:s:v:0",
                "title=MKV Tool test pattern",
                "-metadata:s:a:0",
                "language=eng",
                "-metadata:s:a:0",
                "title=440 Hz default track",
                "-metadata:s:a:1",
                "language=eng",
                "-metadata:s:a:1",
                "title=880 Hz alternate track",
                "-metadata:s:s:0",
                "language=eng",
                "-metadata:s:s:0",
                "title=English forced signs",
                "-metadata:s:s:1",
                "language=eng",
                "-metadata:s:s:1",
                "title=English full subtitles",
                "-metadata:s:s:2",
                "language=chi",
                "-metadata:s:s:2",
                "title=中文完整字幕",
                "-metadata:s:s:3",
                "language=",
                "-metadata:s:s:3",
                "title=Untagged subtitle track",
                "-disposition:v:0",
                "default",
                "-disposition:a:0",
                "default",
                "-disposition:a:1",
                "0",
                "-disposition:s:0",
                "default+forced",
                "-disposition:s:1",
                "0",
                "-disposition:s:2",
                "0",
                "-disposition:s:3",
                "0",
                str(out),
            ]
        )

        result = run_capture(args, timeout=180)
        if result.returncode != 0:
            raise SampleGenerationError(
                "样片生成失败：\n"
                f"{result.stderr_tail()}\n\n命令：{' '.join(args)}"
            )
        if not out.exists() or out.stat().st_size == 0:
            raise SampleGenerationError("FFmpeg 报告成功，但没有找到生成的样片。")
    return out


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="生成多音轨/多字幕 MKV 样片")
    parser.add_argument(
        "--out",
        "--output",
        dest="output",
        default="samples",
        help="输出 .mkv 文件路径，或存放样片的目录（默认：samples/）",
    )
    parser.add_argument(
        "--offset-demo",
        action="store_true",
        help="生成带 +0.350/-0.150 秒相对偏移的样片",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="同时生成普通样片和偏移样片到 --out 目录",
    )
    parser.add_argument("--duration", type=float, default=3.0, help="样片时长，默认 3 秒")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    output = Path(args.output)
    if args.all:
        directory = output if output.suffix == "" else output.parent
        normal = generate_sample(directory / "multitrack.mkv", duration=args.duration)
        offset = generate_sample(
            directory / "multitrack.offsets.mkv",
            duration=args.duration,
            offset_demo=True,
        )
        print(f"已生成：\n  {normal}\n  {offset}")
        return 0

    target = output
    if output.suffix == "":
        target = output / ("multitrack.offsets.mkv" if args.offset_demo else "multitrack.mkv")
    path = generate_sample(target, duration=args.duration, offset_demo=args.offset_demo)
    print(f"已生成样片：{path}")
    if not args.offset_demo:
        print("偏移样片可运行：python -m mkv_tool.sample --offset-demo --out samples")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
