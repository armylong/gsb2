"""导出：选中截图、带时间标签的总览图（contact sheet）、清单 zip。

清单与导出图片一一对应；未生成完成、已取消或未勾选的帧不会出现在压缩包里。
"""

from __future__ import annotations

import io
import json
import os
import zipfile
from datetime import datetime
from typing import TYPE_CHECKING

from PIL import Image, ImageDraw, ImageFont

if TYPE_CHECKING:
    from .pipeline import Candidate, Job

CONTACT_THUMB_WIDTH = 320
CONTACT_COLUMNS = 4
CONTACT_PADDING = 12
CONTACT_LABEL_HEIGHT = 34


def _fmt_time(seconds: float) -> str:
    """秒数格式化为 HH:MM:SS.mmm。"""
    if seconds < 0:
        seconds = 0.0
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = seconds - hours * 3600 - minutes * 60
    return f"{hours:02d}:{minutes:02d}:{secs:06.3f}"


def _font(size: int = 15) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in (
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        if os.path.exists(candidate):
            try:
                return ImageFont.truetype(candidate, size)
            except OSError:
                continue
    return ImageFont.load_default()


def build_contact_sheet(candidates: list["Candidate"], job: "Job") -> bytes:
    """生成带时间标签的总览图 PNG，保持每张截图原始宽高比。"""
    rendered: list[tuple[Image.Image, "Candidate"]] = []
    for cand in candidates:
        if not cand.image_ready or not cand.image_path:
            continue
        with Image.open(cand.image_path) as im:
            im = im.convert("RGB")
            scale = CONTACT_THUMB_WIDTH / im.width
            thumb = im.resize(
                (CONTACT_THUMB_WIDTH, max(1, round(im.height * scale))),
                Image.LANCZOS,
            )
            rendered.append((thumb, cand))

    if not rendered:
        raise ValueError("没有可用于总览图的已生成截图。")

    rows = math_ceil_div(len(rendered), CONTACT_COLUMNS)
    cell_height = max(t.height for t, _ in rendered) + CONTACT_LABEL_HEIGHT
    width = CONTACT_COLUMNS * (CONTACT_THUMB_WIDTH + CONTACT_PADDING) + CONTACT_PADDING
    height = rows * (cell_height + CONTACT_PADDING) + CONTACT_PADDING
    sheet = Image.new("RGB", (width, height), (245, 245, 245))
    draw = ImageDraw.Draw(sheet)
    font = _font(15)

    for i, (thumb, cand) in enumerate(rendered):
        row, col = divmod(i, CONTACT_COLUMNS)
        x = CONTACT_PADDING + col * (CONTACT_THUMB_WIDTH + CONTACT_PADDING)
        y = CONTACT_PADDING + row * (cell_height + CONTACT_PADDING)
        sheet.paste(thumb, (x, y))
        label = _fmt_time(cand.actual_time)
        draw.rectangle(
            [x, y + thumb.height, x + CONTACT_THUMB_WIDTH, y + thumb.height + CONTACT_LABEL_HEIGHT],
            fill=(30, 30, 30),
        )
        draw.text(
            (x + 8, y + thumb.height + 8),
            label,
            fill=(255, 255, 255),
            font=font,
        )

    buf = io.BytesIO()
    sheet.save(buf, format="PNG")
    return buf.getvalue()


def math_ceil_div(a: int, b: int) -> int:
    return -(-a // b)


def _export_entries(job: "Job") -> list[tuple["Candidate", str]]:
    """返回 (候选, 压缩包内文件名)，仅包含已勾选且已生成完成的帧。"""
    chosen = [
        c
        for c in sorted(job.candidates.values(), key=lambda c: c.actual_time)
        if c.selected and c.image_ready and c.image_path
    ]
    entries = []
    for i, cand in enumerate(chosen, start=1):
        ext = os.path.splitext(cand.image_path)[1].lower() or ".jpg"
        name = f"frames/{i:03d}_t{cand.actual_time:09.3f}s{ext}"
        entries.append((cand, name))
    return entries


def build_manifest(job: "Job", entries: list[tuple["Candidate", str]]) -> dict:
    stream = job.video_stream_info()
    return {
        "exported_at": datetime.now().isoformat(timespec="seconds"),
        "video": {
            "file_name": job.original_name,
            "duration_seconds": round(job.duration, 6),
            "duration_hms": _fmt_time(job.duration),
            "processed_stream_index": job.stream_index,
            "codec": stream.get("codec"),
            "width": stream.get("width"),
            "height": stream.get("height"),
            "rotation_degrees_clockwise": job.rotation,
            "variable_frame_rate": job.is_vfr,
            "avg_frame_rate": stream.get("avg_frame_rate"),
            "r_frame_rate": stream.get("r_frame_rate"),
        },
        "analysis_parameters": job.last_params,
        "frame_count": len(entries),
        "frames": [
            {
                "export_file": file_name,
                "frame_index_in_stream": cand.frame_index,
                "requested_time_seconds": round(cand.requested_time, 6),
                "requested_time_hms": _fmt_time(cand.requested_time),
                "actual_frame_time_seconds": round(cand.actual_time, 6),
                "actual_frame_time_hms": _fmt_time(cand.actual_time),
                "time_offset_seconds": round(
                    cand.actual_time - cand.requested_time, 6
                ),
                "source": cand.source,
                "merged_duplicate_requests": [
                    {"requested_time_seconds": round(t, 6), "time_hms": _fmt_time(t)}
                    for t in cand.merged_requests
                ],
            }
            for cand, file_name in entries
        ],
        "notes": [
            "actual_frame_time 为视频中真实解码帧的展示时间戳；请求时间落在两帧之间时，"
            "已选择时间最接近的真实帧，time_offset_seconds 记录两者差值。",
            "截图已按旋转信息校正方向，并保持原始宽高比。",
            "未勾选、未生成完成或已取消的帧不在本压缩包内。",
        ],
    }


def build_export_zip(job: "Job") -> bytes:
    entries = _export_entries(job)
    if not entries:
        raise ValueError("没有可导出的已完成截图（请先勾选候选帧并等待生成完成）。")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for cand, file_name in entries:
            zf.write(cand.image_path, arcname=file_name)
        sheet = build_contact_sheet([c for c, _ in entries], job)
        zf.writestr("contact_sheet.png", sheet)
        manifest = build_manifest(job, entries)
        zf.writestr(
            "manifest.json",
            json.dumps(manifest, ensure_ascii=False, indent=2),
        )
        zf.writestr(
            "manifest.csv",
            _manifest_csv(entries),
        )
    return buf.getvalue()


def _manifest_csv(entries: list[tuple["Candidate", str]]) -> str:
    import csv

    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(
        [
            "export_file",
            "frame_index_in_stream",
            "requested_time_seconds",
            "actual_frame_time_seconds",
            "time_offset_seconds",
            "source",
        ]
    )
    for cand, file_name in entries:
        writer.writerow(
            [
                file_name,
                cand.frame_index,
                f"{cand.requested_time:.6f}",
                f"{cand.actual_time:.6f}",
                f"{cand.actual_time - cand.requested_time:.6f}",
                cand.source,
            ]
        )
    return out.getvalue()
