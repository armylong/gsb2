"""Build finite-size sprite pages and their machine-readable manifest."""

from __future__ import annotations

import json
import os
import re
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ffmpegops import detect_black_crop, extract_processed_frame
from .imagetools import RGBImage, parse_color, text_size
from .probe import TIME_EPSILON, VideoInfo, probe_video, choose_frame, resolve_binary, sibling_ffprobe
from .targets import build_scrub_intervals, parse_target_times


SCHEMA = "thumb-pack@1"


@dataclass
class PackConfig:
    output_dir: str
    interval: float | None = None
    times: str | None = None
    times_file: str | None = None

    columns: int = 5
    rows_per_page: int = 2
    thumb_width: int | None = None
    thumb_height: int | None = None
    long_edge: int = 192

    padding: int = 6
    border: int = 1
    gap: int = 10
    margin: int = 18
    label_height: int = 12
    show_labels: bool = True

    fit: str = "contain"  # contain | cover | stretch
    black_bars: str = "keep"  # keep | crop
    crop_limit: int = 24
    letterbox_color: str = "#000000"
    page_color: str = "#181c26"
    cell_color: str = "#2b3242"
    border_color: str = "#5b6478"
    collision_color: str = "#facc15"
    error_color: str = "#dc2626"

    image_format: str = "png"
    jpeg_quality: int = 3

    ffmpeg_bin: str = "ffmpeg"
    ffprobe_bin: str | None = None
    force_bad_slots: set[int] = field(default_factory=set)

    def validate(self) -> None:
        if self.columns < 1 or self.rows_per_page < 1:
            raise ValueError("columns and rows-per-page must be >= 1")
        if min(self.padding, self.border, self.gap, self.margin) < 0:
            raise ValueError("padding/border/gap/margin must be non-negative")
        if self.fit not in ("contain", "cover", "stretch"):
            raise ValueError("fit must be contain, cover, or stretch")
        if self.black_bars not in ("keep", "crop"):
            raise ValueError("black-bars must be keep or crop")
        if self.image_format not in ("png", "jpg", "jpeg"):
            raise ValueError("image-format must be png or jpg")


def resolve_thumb_dimensions(
    info: VideoInfo,
    width: int | None,
    height: int | None,
    long_edge: int = 192,
) -> tuple[int, int]:
    aw = max(1, info.aspect_width)
    ah = max(1, info.aspect_height)
    if width and height:
        return max(16, int(width)), max(16, int(height))
    if width and not height:
        return int(width), max(16, _even(round(width * ah / aw)))
    if height and not width:
        return max(16, _even(round(height * aw / ah))), int(height)

    if aw >= ah:
        tw = long_edge
        th = max(16, _even(round(long_edge * ah / aw)))
    else:
        th = long_edge
        tw = max(16, _even(round(long_edge * aw / ah)))
    return tw, th


def _even(v: int) -> int:
    return v if v % 2 == 0 else v + 1


def geometry_for(config: PackConfig, thumb_w: int, thumb_h: int) -> dict[str, int]:
    label_h = config.label_height if config.show_labels else 0
    label_gap = 3 if label_h else 0
    chrome = config.border + config.padding
    cell_w = thumb_w + chrome * 2
    cell_h = thumb_h + chrome * 2 + label_h + label_gap
    capacity = config.columns * config.rows_per_page
    page_w = config.margin * 2 + config.columns * cell_w + (config.columns - 1) * config.gap
    page_h = (
        config.margin * 2
        + config.rows_per_page * cell_h
        + (config.rows_per_page - 1) * config.gap
    )
    return {
        "thumbWidth": thumb_w,
        "thumbHeight": thumb_h,
        "labelHeight": label_h,
        "labelGap": label_gap,
        "chrome": chrome,
        "cellWidth": cell_w,
        "cellHeight": cell_h,
        "columns": config.columns,
        "rowsPerPage": config.rows_per_page,
        "capacityPerPage": capacity,
        "pageWidth": page_w,
        "pageHeight": page_h,
        "padding": config.padding,
        "border": config.border,
        "gap": config.gap,
        "margin": config.margin,
    }


def slot_rect(slot: int, geo: dict[str, int]) -> dict[str, dict[str, int]]:
    capacity = geo["capacityPerPage"]
    in_page = slot % capacity
    col = in_page % geo["columns"]
    row = in_page // geo["columns"]
    cell_x = geo["margin"] + col * (geo["cellWidth"] + geo["gap"])
    cell_y = geo["margin"] + row * (geo["cellHeight"] + geo["gap"])
    chrome = geo["chrome"]
    label_h = geo["labelHeight"]
    label_gap = geo["labelGap"]
    frame_x = cell_x + chrome
    frame_y = cell_y + chrome + label_h + label_gap
    return {
        "cell": {
            "x": cell_x,
            "y": cell_y,
            "width": geo["cellWidth"],
            "height": geo["cellHeight"],
        },
        "label": {
            "x": frame_x,
            "y": cell_y + chrome,
            "width": geo["thumbWidth"],
            "height": label_h,
        },
        "frame": {
            "x": frame_x,
            "y": frame_y,
            "width": geo["thumbWidth"],
            "height": geo["thumbHeight"],
        },
    }


def generate_pack(video_path: str, config: PackConfig) -> dict[str, Any]:
    config.validate()
    video_path = os.path.abspath(video_path)
    out_dir = Path(config.output_dir).expanduser().resolve()
    pages_dir = out_dir / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)
    _clean_old_pages(pages_dir)

    ffmpeg_bin = resolve_binary(
        "ffmpeg", None if config.ffmpeg_bin == "ffmpeg" else config.ffmpeg_bin
    )
    ffprobe_bin = config.ffprobe_bin or sibling_ffprobe(ffmpeg_bin)
    info = probe_video(video_path, ffprobe_bin)
    thumb_w, thumb_h = resolve_thumb_dimensions(
        info, config.thumb_width, config.thumb_height, config.long_edge
    )
    geo = geometry_for(config, thumb_w, thumb_h)

    targets = parse_target_times(
        times=config.times,
        times_file=config.times_file,
        interval=config.interval,
        duration=info.duration,
    )
    scrub_intervals = build_scrub_intervals(targets, info.duration)

    invalid_bad = [s for s in config.force_bad_slots if s < 0 or s >= len(targets)]
    if invalid_bad:
        raise ValueError(f"force-bad slot(s) out of range 0..{len(targets) - 1}: {invalid_bad}")

    selected = [choose_frame(info.frames, t) for t in targets]
    groups: dict[int, list[int]] = defaultdict(list)
    for slot, frame in enumerate(selected):
        groups[frame.index].append(slot)

    crop = None
    if config.black_bars == "crop":
        crop = detect_black_crop(video_path, ffmpeg_bin, config.crop_limit)

    ext = "jpg" if config.image_format in ("jpg", "jpeg") else "png"
    total_slots = len(targets)
    page_count = max(1, (total_slots + geo["capacityPerPage"] - 1) // geo["capacityPerPage"])

    page_colors = {
        "page": parse_color(config.page_color),
        "cell": parse_color(config.cell_color),
        "border": parse_color(config.border_color),
        "collision": parse_color(config.collision_color),
        "error": parse_color(config.error_color),
        "white": (245, 247, 252),
        "dark": (20, 22, 28),
    }

    frame_cache: dict[int, bytes | Exception] = {}
    page_images: dict[int, RGBImage] = {}
    samples: list[dict[str, Any]] = []

    for slot, (target, frame) in enumerate(zip(targets, selected)):
        page_index = slot // geo["capacityPerPage"] + 1
        if page_index not in page_images:
            page_images[page_index] = RGBImage.new(
                geo["pageWidth"], geo["pageHeight"], page_colors["page"]
            )
        canvas = page_images[page_index]
        rects = slot_rect(slot, geo)
        cell, label_rect, frame_rect = rects["cell"], rects["label"], rects["frame"]
        same_slots = groups[frame.index]
        collision = len(same_slots) > 1

        canvas.fill_rect(cell["x"], cell["y"], cell["width"], cell["height"], page_colors["cell"])
        border_color = page_colors["collision"] if collision else page_colors["border"]
        canvas.draw_rect(
            cell["x"], cell["y"], cell["width"], cell["height"], border_color, config.border
        )

        status = "ok"
        error: dict[str, Any] | None = None
        raw: bytes | None = None

        if slot in config.force_bad_slots:
            status = "error"
            error = {
                "code": "SIMULATED_BAD_IMAGE",
                "message": f"forced failure for slot {slot}; placeholder keeps its grid rectangle",
            }
        elif frame.index not in frame_cache:
            try:
                frame_cache[frame.index] = extract_processed_frame(
                    video_path,
                    frame.index,
                    thumb_w,
                    thumb_h,
                    ffmpeg_bin=ffmpeg_bin,
                    fit=config.fit,
                    letterbox_color=config.letterbox_color,
                    crop=crop,
                )
            except Exception as exc:  # one bad frame must not abort the pack
                frame_cache[frame.index] = exc

        if status == "ok":
            cached = frame_cache[frame.index]
            if isinstance(cached, Exception):
                status = "error"
                error = {"code": "EXTRACT_FAILED", "message": str(cached)}
            else:
                raw = cached

        if status == "error" or raw is None:
            _draw_bad_placeholder(canvas, frame_rect, slot, frame.index, page_colors["error"])
        else:
            try:
                canvas.blit(raw, frame_rect["x"], frame_rect["y"], thumb_w, thumb_h)
            except ValueError as exc:
                status = "error"
                error = {"code": "COMPOSITE_FAILED", "message": str(exc)}
                _draw_bad_placeholder(canvas, frame_rect, slot, frame.index, page_colors["error"])

        if config.show_labels and geo["labelHeight"] > 0:
            label = f"{slot:02d} F{frame.index:03d} {target:05.2f}"
            max_w = label_rect["width"]
            while label and text_size(label, 1)[0] > max_w:
                label = label[:-1]
            canvas.draw_text(
                label,
                label_rect["x"],
                label_rect["y"] + 2,
                scale=1,
                color=page_colors["white"],
                shadow=None,
            )
            if collision:
                dot_x = cell["x"] + cell["width"] - 9
                dot_y = cell["y"] + 4
                canvas.fill_rect(dot_x, dot_y, 5, 5, page_colors["collision"])

        frame_end = (
            info.duration
            if abs(frame.time + frame.duration - info.duration) < TIME_EPSILON * 10
            or frame.index == info.frames[-1].index
            else frame.time + frame.duration
        )
        is_terminal_frame = frame.index == info.frames[-1].index
        sample = {
            "slot": slot,
            "requestedTime": round(target, 9),
            "pageIndex": page_index,
            "pageFile": f"pages/page_{page_index:03d}.{ext}",
            "status": status,
            "error": error,
            "cellRect": cell,
            "labelRect": label_rect,
            "rect": frame_rect,
            "scrubInterval": scrub_intervals[slot],
            "source": {
                "frameIndex": frame.index,
                "keyFrame": frame.key_frame,
                "integerPts": frame.pts_integer,
                "rawPtsTime": round(frame.raw_pts, 9),
                "normalizedPtsTime": round(frame.time, 9),
                "duration": round(frame.duration, 9),
                "frameInterval": {
                    "start": round(frame.time, 9),
                    "end": round(frame_end, 9),
                    "endExclusive": not is_terminal_frame,
                    "terminalEndInclusive": is_terminal_frame,
                },
            },
            "sameFrameSlots": same_slots if collision else [],
        }
        samples.append(sample)

    # Draw quiet dashed placeholders for unused fixed-grid cells.
    for slot in range(total_slots, geo["capacityPerPage"] * page_count):
        page_index = slot // geo["capacityPerPage"] + 1
        if page_index not in page_images:
            continue
        rects = slot_rect(slot, geo)
        canvas = page_images[page_index]
        canvas.draw_dashed_rect(
            rects["cell"]["x"] + 3,
            rects["cell"]["y"] + 3,
            rects["cell"]["width"] - 6,
            rects["cell"]["height"] - 6,
            parse_color(config.border_color),
            dash=4,
        )

    pages: list[dict[str, Any]] = []
    for page_index in range(1, page_count + 1):
        filename = f"page_{page_index:03d}.{ext}"
        rel = f"pages/{filename}"
        abs_path = pages_dir / filename
        img = page_images[page_index]
        img.save(str(abs_path), ffmpeg_bin=ffmpeg_bin, quality=config.jpeg_quality)
        pages.append(
            {
                "index": page_index,
                "file": rel,
                "width": geo["pageWidth"],
                "height": geo["pageHeight"],
                "bytes": abs_path.stat().st_size,
                "mimeType": "image/jpeg" if ext in ("jpg", "jpeg") else "image/png",
            }
        )

    unique_frames = len(groups)
    error_count = sum(1 for s in samples if s["status"] == "error")
    manifest = {
        "schema": SCHEMA,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {
            **info.to_public_dict(),
            "givenPath": video_path,
            "filename": os.path.basename(video_path),
            "sizeBytes": os.path.getsize(video_path),
            "sourceCrop": crop,
        },
        "timeline": {
            "startsAt": 0.0,
            "duration": round(info.duration, 9),
            "lastValidPreviewTime": round(info.duration, 9),
            "originRawPtsTime": round(info.origin_raw_pts, 9),
            "rawStartTime": info.raw_start_time,
            "epsilonSeconds": TIME_EPSILON,
            "selectionRule": "last decoded frame with normalized PTS <= requested time + epsilon",
            "normalizationRule": "all frame times subtract the minimum FFprobe PTS time; player and manifest start at zero",
            "lookupRule": "choose sample whose scrubInterval contains t; non-terminal end is exclusive, duration is inclusive",
        },
        "geometry": {
            **geo,
            "fit": config.fit,
            "blackBars": config.black_bars,
            "letterboxColor": config.letterbox_color,
            "paddingPixels": config.padding,
        },
        "pages": pages,
        "samples": samples,
        "frameGroups": [
            {
                "frameIndex": frame_index,
                "slots": slots,
                "requestedTimes": [samples[s]["requestedTime"] for s in slots],
                "count": len(slots),
            }
            for frame_index, slots in sorted(groups.items())
            if len(slots) > 1
        ],
        "savings": {
            "requestedTargets": total_slots,
            "slots": total_slots,
            "uniqueSourceFrames": unique_frames,
            "repeatedFrameSlots": total_slots - unique_frames,
            "pageCount": page_count,
            "unpackedImageFiles": total_slots,
            "actualImageFiles": page_count,
            "actualImageBytes": sum(p["bytes"] for p in pages),
            "savedFileCount": total_slots - page_count,
            "note": "savedFileCount compares one small image per target slot with the exported page images",
        },
        "validation": {
            "errorTiles": error_count,
            "forcedBadSlots": sorted(config.force_bad_slots),
        },
        "artifacts": {
            "manifest": "manifest.json",
            "vtt": "thumbnails.vtt",
            "viewer": "viewer.html",
        },
    }

    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    vtt_path = out_dir / "thumbnails.vtt"
    vtt_path.write_text(render_vtt(manifest), encoding="utf-8")
    viewer_path = out_dir / "viewer.html"
    viewer_path.write_text(render_viewer(manifest), encoding="utf-8")
    return manifest


def _clean_old_pages(pages_dir: Path) -> None:
    for pattern in ("page_*.png", "page_*.jpg", "page_*.jpeg"):
        for old in pages_dir.glob(pattern):
            try:
                old.unlink()
            except OSError:
                pass


def _draw_bad_placeholder(
    canvas: RGBImage,
    rect: dict[str, int],
    slot: int,
    frame_index: int,
    color: tuple[int, int, int],
) -> None:
    x, y, w, h = rect["x"], rect["y"], rect["width"], rect["height"]
    canvas.fill_rect(x, y, w, h, (64, 24, 28))
    # Diagonal warning stripes, clipped by a second fill? draw_rect border and
    # a few broad bands are sufficient and remain inside the rectangle.
    for k in range(-h, w, 18):
        for yy in range(h):
            xx = x + k + yy
            if x <= xx < x + w and 0 <= yy < h:
                if 0 <= xx < canvas.width:
                    canvas.pixels[((y + yy) * canvas.width + xx) * 3 : ((y + yy) * canvas.width + xx) * 3 + 3] = bytes(color)
    canvas.fill_rect(x + 4, y + max(4, h // 2 - 18), w - 8, 36, (35, 18, 20))
    text = "BAD"
    scale = 3 if w >= 70 and h >= 40 else 2
    tw, th = text_size(text, scale)
    canvas.draw_text(text, x + (w - tw) // 2, y + max(6, (h - th) // 2 - 4), scale, (255, 235, 235), (0, 0, 0))
    sub = f"S{slot} F{frame_index}"
    if w >= text_size(sub, 1)[0] + 4:
        sw, _ = text_size(sub, 1)
        canvas.draw_text(sub, x + (w - sw) // 2, y + h - 12, 1, (255, 210, 210), None)
    canvas.draw_rect(x, y, w, h, color, 2)


def _vtt_time(t: float) -> str:
    if t < 0:
        t = 0
    ms = int(round(t * 1000))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, milli = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{milli:03d}"


def render_vtt(manifest: dict[str, Any]) -> str:
    lines = ["WEBVTT", "NOTE Scrub intervals use the same zero timeline as manifest.json", ""]
    for sample in manifest["samples"]:
        iv = sample["scrubInterval"]
        rect = sample["rect"]
        lines.append(f"{_vtt_time(iv['start'])} --> {_vtt_time(iv['end'])}")
        lines.append(
            f"{sample['pageFile']}#xywh={rect['x']},{rect['y']},{rect['width']},{rect['height']}"
        )
        lines.append("")
    return "\n".join(lines)


def render_viewer(manifest: dict[str, Any]) -> str:
    template_path = Path(__file__).with_name("web") / "viewer.html"
    html = template_path.read_text(encoding="utf-8")
    payload = json.dumps(manifest, ensure_ascii=True, separators=(",", ":")).replace("<", "\\u003c")
    token = "__THUMB_PACK_MANIFEST_JSON__"
    if token not in html:
        raise RuntimeError("viewer template is missing manifest token")
    return html.replace(token, payload)
