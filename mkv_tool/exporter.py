from __future__ import annotations

import os
import tempfile
from dataclasses import replace
from pathlib import Path
from typing import Any

from .content import packet_stream_hash
from .edits import ExpectedStream, ExportPlan
from .errors import MuxError, ffmpeg_path, require_source
from .runner import run_capture
from .verification import VerificationReport, verify_output

# FFmpeg disposition names accepted by `-disposition`.
_KNOWN_DISPOSITIONS = (
    "default",
    "dub",
    "original",
    "comment",
    "lyrics",
    "karaoke",
    "forced",
    "hearing_impaired",
    "visual_impaired",
    "clean_effects",
    "attached_pic",
    "captions",
    "descriptions",
    "metadata",
    "dependent",
    "still_image",
    "timed_thumbnails",
    "non_diegetic",
    "multilayer",
)


def disposition_value(
    source_disposition: dict[str, bool] | None,
    *,
    default: bool,
    forced: bool,
) -> str:
    old = source_disposition or {}
    flags: list[str] = []
    for name in _KNOWN_DISPOSITIONS:
        if name == "default":
            enabled = default
        elif name == "forced":
            enabled = forced
        else:
            enabled = bool(old.get(name))
        if enabled:
            flags.append(name)
    return "+".join(flags) if flags else "0"


def spec_for(expected: ExpectedStream, counters: dict[str, int]) -> str:
    if expected.codec_type == "video":
        letter = "v"
    elif expected.codec_type == "audio":
        letter = "a"
    elif expected.codec_type == "subtitle":
        letter = "s"
    else:
        letter = expected.codec_type[:1] or "u"
    type_index = counters.get(letter, 0)
    counters[letter] = type_index + 1
    return f"{letter}:{type_index}"


def build_ffmpeg_args(plan: ExportPlan, temp_output: Path) -> list[str]:
    exe = ffmpeg_path(plan.ffmpeg)
    args: list[str] = [exe, "-hide_banner", "-nostdin", "-y", "-copyts", "-i", str(plan.source)]

    # Explicit maps are essential: output position follows the user's order and
    # never depends on codec guessing or implicit stream selection.
    for stream in plan.expected:
        args.extend(["-map", f"0:{stream.source_index}"])

    # Stream copy preserves the chosen codecs.  No audio/video/subtitle encoder
    # is inserted anywhere in this command.
    args.extend(["-c", "copy"])

    counters: dict[str, int] = {}
    for stream in plan.expected:
        spec = spec_for(stream, counters)
        # key= with an empty value explicitly clears a source title/language.
        args.extend([f"-metadata:s:{spec}", f"language={stream.language}"])
        args.extend([f"-metadata:s:{spec}", f"title={stream.title}"])
        value = disposition_value(
            stream.source_disposition,
            default=stream.default,
            forced=stream.forced,
        )
        args.extend([f"-disposition:{spec}", value])

    args.extend(["-f", "matroska", str(temp_output)])
    return args


def export_mkv(plan: ExportPlan, *, compute_hashes: bool = True) -> VerificationReport:
    """Mux to a temp file, reopen/verify it, then atomically publish output.

    A failure at any stage leaves no file at ``plan.output`` unless a previous
    verified file already existed; that old file is replaced only after the new
    temp file passes verification.
    """
    source = require_source(plan.source)
    plan.source = source

    # Compute identity hashes before muxing.  This catches a source that
    # disappeared before export and gives verification an exact mapping target.
    if compute_hashes and plan.verify_content:
        hashed: list[ExpectedStream] = []
        for stream in plan.expected:
            digest = packet_stream_hash(plan.source, stream.source_index, ffmpeg=plan.ffmpeg)
            hashed.append(replace(stream, packet_hash=digest))
        plan.expected = hashed

    temp_output = make_temp_path(plan.output)
    args = build_ffmpeg_args(plan, temp_output)

    try:
        result = run_capture(args)
        if result.returncode != 0:
            raise MuxError(
                "FFmpeg 封装失败，未生成成品：\n"
                f"{result.stderr_tail()}\n\n命令：{' '.join(quote_arg(a) for a in args)}"
            )
        if not temp_output.exists() or temp_output.stat().st_size == 0:
            raise MuxError("FFmpeg 返回成功但临时成品不存在或为空，未发布输出。")

        report = verify_output(temp_output, plan)
        if not report.ok:
            details = "\n".join(report.summary_lines())
            # VerificationFailedError is a MkvToolError; caller shows it.
            from .errors import VerificationFailedError

            raise VerificationFailedError(
                "输出复核失败，已删除临时文件，不会把它当作成功成品：\n" + details
            )

        plan.output.parent.mkdir(parents=True, exist_ok=True)
        os.replace(temp_output, plan.output)

        # Reopen the published path itself, not only the temp inode.  This is
        # the explicit "reopen output and check actual order" step.
        final_report = verify_output(plan.output, plan)
        if not final_report.ok:
            details = "\n".join(final_report.summary_lines())
            try:
                plan.output.unlink()
            except OSError:
                pass
            from .errors import VerificationFailedError

            raise VerificationFailedError(
                "成品发布后的复核失败，已删除输出，不会把它当作成功成品：\n" + details
            )
        return final_report
    finally:
        try:
            if temp_output.exists():
                temp_output.unlink()
        except OSError:
            pass


def make_temp_path(output: Path) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(
        prefix=f".{output.stem}.",
        suffix=".tmp.mkv",
        dir=output.parent,
    )
    os.close(fd)
    return Path(name)


def quote_arg(value: Any) -> str:
    text = str(value)
    if not text or any(ch.isspace() for ch in text):
        return f'"{text.replace(chr(34), chr(92) + chr(34))}"'
    return text
