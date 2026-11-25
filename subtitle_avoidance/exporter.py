"""使用与预览相同的 LayoutEngine/render_subtitle 渲染 PNG，再交给 ffmpeg 叠加。"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Callable

from PySide6.QtGui import QImage, QPainter

from .layout import LayoutEngine, render_subtitle
from .media import run_ffmpeg
from .model import Cue, Placement
from .srt import write_srt

ProgressCb = Callable[[str, int, int], None]


def render_cue_png(
    path: str | Path,
    width: int,
    height: int,
    cue: Cue,
    placement: Placement,
    layout_engine: LayoutEngine,
) -> Path:
    image = QImage(width, height, QImage.Format.Format_RGBA8888)
    image.fill(0)
    painter = QPainter(image)
    try:
        laid = layout_engine.layout(cue.text)
        render_subtitle(painter, laid, placement.box, layout_engine.style)
    finally:
        painter.end()
    path = Path(path)
    if not image.save(str(path), "PNG"):
        raise RuntimeError(f"无法保存字幕图片: {path}")
    return path


def export_video(
    video_path: str | Path,
    output_path: str | Path,
    width: int,
    height: int,
    cues: list[Cue],
    placements: dict[str, Placement],
    style: dict | None = None,
    strict: bool = True,
    progress: ProgressCb | None = None,
    work_dir: str | Path | None = None,
) -> Path:
    video_path = Path(video_path)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    visible = [c for c in cues if c.text.strip() and c.id in placements]
    unsafe = [
        c
        for c in visible
        if not placements[c.id].safe and not placements[c.id].manual
    ]
    if strict and unsafe:
        ids = ", ".join(str(c.index) for c in unsafe)
        raise RuntimeError(f"字幕 {ids} 仍无安全位置或人工指定位置，已停止导出")

    engine = LayoutEngine(width, height, style)
    temp_ctx = None
    if work_dir is None:
        temp_ctx = tempfile.TemporaryDirectory(prefix="subtitle_dodge_")
        png_dir = Path(temp_ctx.name)
    else:
        png_dir = Path(work_dir)
        png_dir.mkdir(parents=True, exist_ok=True)

    try:
        png_inputs: list[tuple[Cue, Path]] = []
        for i, cue in enumerate(visible, 1):
            if progress:
                progress("render", i, len(visible))
            png_path = png_dir / f"cue_{i:04d}_{cue.id}.png"
            render_cue_png(png_path, width, height, cue, placements[cue.id], engine)
            png_inputs.append((cue, png_path))

        args: list[str] = ["-i", str(video_path)]
        for _, png_path in png_inputs:
            # 单张 PNG 只提供一帧；overlay 的 eof_action=repeat 会持续复用它，
            # 再由 enable 表达式控制精确显示区间。不能加 -loop 1，否则输入无限长。
            args += ["-i", str(png_path)]

        filter_parts: list[str] = []
        previous = "[0:v]"
        for i, (cue, _) in enumerate(png_inputs, start=1):
            out_label = "[vout]" if i == len(png_inputs) else f"[v{i}]"
            start = max(0.0, cue.start)
            end = max(start, cue.end)
            expr = f"gte(t,{start:.6f})*lt(t,{end:.6f})"
            filter_parts.append(
                f"{previous}[{i}:v]overlay=0:0:format=auto:eof_action=repeat:"
                f"enable='{expr}'{out_label}"
            )
            previous = out_label

        if not png_inputs:
            filter_parts.append("[0:v]null[vout]")

        args += [
            "-filter_complex",
            ";".join(filter_parts),
            "-map",
            "[vout]",
            "-map",
            "0:a?",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
        if progress:
            progress("ffmpeg", 0, 1)
        run_ffmpeg(args)

        srt_output = output_path.with_suffix(".srt")
        write_srt(srt_output, cues)
        return output_path
    finally:
        if temp_ctx is not None:
            temp_ctx.cleanup()
