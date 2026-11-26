"""Local consistency and pixel verification for an exported pack."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from .ffmpegops import extract_processed_frame
from .imagetools import read_image_size
from .probe import probe_video, choose_frame
from .packer import slot_rect


def lookup_manifest(manifest: dict[str, Any], time_seconds: float) -> dict[str, Any] | None:
    duration = float(manifest["timeline"]["duration"])
    t = max(0.0, min(float(time_seconds), duration))
    for sample in manifest["samples"]:
        iv = sample["scrubInterval"]
        if t < iv["start"] - 1e-9:
            continue
        if iv.get("terminalEndInclusive"):
            if iv["start"] - 1e-9 <= t <= iv["end"] + 1e-9:
                return sample
        elif iv["start"] - 1e-9 <= t < iv["end"] - 1e-9:
            return sample
    # Float boundaries and malformed hand-edited manifests fall back to the
    # last sample not starting after t.
    candidates = [s for s in manifest["samples"] if s["scrubInterval"]["start"] <= t + 1e-9]
    return candidates[-1] if candidates else None


def verify_pack(
    pack_dir: str | os.PathLike[str],
    video: str | None = None,
    *,
    check_pixels: bool = True,
    ffprobe_bin: str | None = None,
    ffmpeg_bin: str = "ffmpeg",
) -> dict[str, Any]:
    root = Path(pack_dir).expanduser().resolve()
    report: dict[str, Any] = {
        "ok": True,
        "packDir": str(root),
        "errors": [],
        "warnings": [],
        "pages": [],
        "samples": [],
        "pixelChecks": [],
    }

    manifest_path = root / "manifest.json"
    if not manifest_path.exists():
        report["ok"] = False
        report["errors"].append({"code": "MANIFEST_MISSING", "message": f"missing {manifest_path}"})
        return report
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        report["ok"] = False
        report["errors"].append({"code": "MANIFEST_INVALID_JSON", "message": str(exc)})
        return report

    geo = manifest.get("geometry") or {}
    pages_by_index = {p["index"]: p for p in manifest.get("pages", [])}
    actual_sizes: dict[int, tuple[int, int] | None] = {}

    for page in manifest.get("pages", []):
        page_report: dict[str, Any] = {**page, "exists": False, "issues": []}
        page_path = root / page["file"]
        page_report["absolutePath"] = str(page_path)
        if not page_path.exists():
            issue = {
                "code": "PAGE_MISSING",
                "message": f"page image cannot be loaded; it may have been moved, renamed, or deleted: {page['file']}",
            }
            page_report["issues"].append(issue)
            report["errors"].append(issue)
            actual_sizes[page["index"]] = None
        else:
            page_report["exists"] = True
            try:
                size = read_image_size(str(page_path))
                actual_sizes[page["index"]] = size
                page_report["actualWidth"], page_report["actualHeight"] = size
                if size != (page["width"], page["height"]):
                    issue = {
                        "code": "PAGE_DIMENSION_MISMATCH",
                        "message": f"{page['file']} is {size[0]}x{size[1]}, manifest expects {page['width']}x{page['height']}",
                    }
                    page_report["issues"].append(issue)
                    report["errors"].append(issue)
            except Exception as exc:
                issue = {"code": "PAGE_UNREADABLE", "message": f"{page['file']}: {exc}"}
                page_report["issues"].append(issue)
                report["errors"].append(issue)
                actual_sizes[page["index"]] = None
        report["pages"].append(page_report)

    seen_rects: dict[int, list[tuple[dict[str, int], int]]] = {}
    for sample in manifest.get("samples", []):
        issues: list[dict[str, str]] = []
        slot = sample.get("slot", -1)
        page_index = sample.get("pageIndex")
        page = pages_by_index.get(page_index)
        if page is None:
            issues.append({"code": "PAGE_ENTRY_MISSING", "message": f"slot {slot}: page index {page_index} is absent from manifest pages"})
        else:
            expected = slot_rect(slot, geo)
            checks = (("cellRect", "cell"), ("rect", "frame"))
            for manifest_key, geometry_key in checks:
                if sample.get(manifest_key) != expected[geometry_key]:
                    issues.append({
                        "code": "RECT_GEOMETRY_MISMATCH",
                        "message": f"slot {slot}: {manifest_key} does not match deterministic grid geometry",
                    })
            actual_size = actual_sizes.get(page_index)
            rect = sample.get("rect") or {}
            if actual_size is None:
                page_abs = root / page["file"]
                if not page_abs.exists():
                    issues.append({
                        "code": "PAGE_MISSING",
                        "message": f"slot {slot} cannot be checked: page {page['file']} was moved, renamed, or deleted",
                    })
                else:
                    issues.append({
                        "code": "PAGE_UNREADABLE",
                        "message": f"slot {slot} cannot be checked: page {page['file']} exists but is not a readable image",
                    })
            elif rect:
                aw, ah = actual_size
                if rect.get("x", 0) < 0 or rect.get("y", 0) < 0 or rect.get("width", 0) <= 0 or rect.get("height", 0) <= 0:
                    issues.append({"code": "RECT_INVALID", "message": f"slot {slot}: invalid rectangle {rect}"})
                elif rect["x"] + rect["width"] > aw or rect["y"] + rect["height"] > ah:
                    over_x = rect["x"] + rect["width"] - aw
                    over_y = rect["y"] + rect["height"] - ah
                    reasons = []
                    if over_x > 0:
                        reasons.append(f"right edge exceeds image width by {over_x}px")
                    if over_y > 0:
                        reasons.append(f"bottom edge exceeds image height by {over_y}px")
                    issues.append({
                        "code": "RECT_OUTSIDE_IMAGE",
                        "message": f"slot {slot} on {page['file']}: rectangle {rect} is outside {aw}x{ah} ({'; '.join(reasons)})",
                    })
            seen_rects.setdefault(page_index, []).append((sample.get("cellRect") or {}, slot))

        if sample.get("status") == "error":
            issues.append({
                "code": "TILE_MARKED_ERROR",
                "message": f"slot {slot} is an intentional/extraction error tile: {(sample.get('error') or {}).get('message', '')}",
            })

        for issue in issues:
            report["errors"].append({"slot": slot, **issue})
        report["samples"].append({"slot": slot, "pageIndex": page_index, "issues": issues})

    # Cell rectangles must not overlap.
    for page_index, items in seen_rects.items():
        for i, (a, sa) in enumerate(items):
            for b, sb in items[i + 1 :]:
                if _rects_overlap(a, b):
                    issue = {"code": "CELLS_OVERLAP", "message": f"slots {sa} and {sb} overlap on page {page_index}"}
                    report["errors"].append(issue)

    # Lookup must always return a sample for every time in the timeline.
    duration = float((manifest.get("timeline") or {}).get("duration") or 0)
    if duration <= 0:
        report["errors"].append({"code": "BAD_DURATION", "message": "manifest timeline duration must be positive"})
    else:
        for fraction in (0.0, 0.001, 0.25, 0.5, 0.75, 0.999, 1.0):
            t = duration * fraction
            if lookup_manifest(manifest, t) is None:
                report["errors"].append({"code": "LOOKUP_GAP", "message": f"no tile found at t={t:.6f}"})

    video_path = video or (manifest.get("source") or {}).get("givenPath")
    if video_path and Path(video_path).exists():
        try:
            info = probe_video(str(video_path), ffprobe_bin)
            if abs(info.duration - duration) > max(0.25, duration * 0.02):
                report["warnings"].append({
                    "code": "DURATION_DIFFERS",
                    "message": f"FFprobe duration {info.duration:.3f} differs from manifest {duration:.3f}",
                })
            # Re-resolve every target and ensure the manifest pointer agrees.
            for sample in manifest.get("samples", []):
                target = sample["requestedTime"]
                fresh = choose_frame(info.frames, target)
                if fresh.index != sample["source"]["frameIndex"]:
                    report["errors"].append({
                        "code": "POINTER_MISMATCH",
                        "slot": sample["slot"],
                        "message": f"target {target}: manifest points to frame {sample['source']['frameIndex']}, fresh probe selects {fresh.index}",
                    })
            if check_pixels:
                _verify_pixels(root, manifest, video_path, ffmpeg_bin, report)
        except Exception as exc:
            report["errors"].append({"code": "VIDEO_VERIFY_FAILED", "message": str(exc)})
    elif video:
        report["errors"].append({"code": "VIDEO_NOT_FOUND", "message": f"video for comparison not found: {video}"})
    else:
        report["warnings"].append({"code": "VIDEO_NOT_CHECKED", "message": "source video path is unavailable; pointer/pixel checks skipped"})

    tile_error_count = sum(1 for e in report["errors"] if e.get("code") == "TILE_MARKED_ERROR")
    report["hasErrorTiles"] = tile_error_count > 0
    report["structuralOk"] = all(e.get("code") != "TILE_MARKED_ERROR" for e in report["errors"])
    report["ok"] = not report["errors"]
    return report


def _rects_overlap(a: dict[str, int], b: dict[str, int]) -> bool:
    if not a or not b:
        return False
    return not (
        a["x"] + a["width"] <= b["x"]
        or b["x"] + b["width"] <= a["x"]
        or a["y"] + a["height"] <= b["y"]
        or b["y"] + b["height"] <= a["y"]
    )


def _ffmpeg_crop_rgb(
    image_path: Path,
    rect: dict[str, int],
    ffmpeg_bin: str,
) -> bytes:
    vf = f"crop={rect['width']}:{rect['height']}:{rect['x']}:{rect['y']},format=rgb24"
    cmd = [
        ffmpeg_bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(image_path),
        "-vf",
        vf,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace"))
    expected = rect["width"] * rect["height"] * 3
    if len(proc.stdout) != expected:
        raise RuntimeError(f"crop produced {len(proc.stdout)} bytes, expected {expected}")
    return proc.stdout


def _compare_rgb(a: bytes, b: bytes) -> dict[str, float | int]:
    if len(a) != len(b):
        raise ValueError("pixel buffer lengths differ")
    total = len(a) // 3
    sum_abs = 0
    max_abs = 0
    bad = 0
    for i in range(0, len(a), 3):
        d = abs(int(a[i]) - int(b[i])) + abs(int(a[i + 1]) - int(b[i + 1])) + abs(int(a[i + 2]) - int(b[i + 2]))
        avg = d / 3
        sum_abs += d
        max_abs = max(max_abs, d)
        if avg > 28:
            bad += 1
    return {
        "pixels": total,
        "meanChannelDiff": round(sum_abs / max(1, len(a)), 3),
        "maxSumDiff": max_abs,
        "badPixelFraction": round(bad / max(1, total), 5),
    }


def _verify_pixels(
    root: Path,
    manifest: dict[str, Any],
    video_path: str,
    ffmpeg_bin: str,
    report: dict[str, Any],
) -> None:
    source_crop = (manifest.get("source") or {}).get("sourceCrop")
    fit = manifest["geometry"].get("fit", "contain")
    color = manifest["geometry"].get("letterboxColor", "#000000")
    lossy_pages = any(p["file"].lower().endswith((".jpg", ".jpeg")) for p in manifest.get("pages", []))

    for sample in manifest.get("samples", []):
        if sample.get("status") == "error":
            continue
        page = next((p for p in manifest["pages"] if p["index"] == sample["pageIndex"]), None)
        if not page:
            continue
        page_path = root / page["file"]
        if not page_path.exists():
            continue
        rect = sample["rect"]
        try:
            expected = extract_processed_frame(
                video_path,
                sample["source"]["frameIndex"],
                rect["width"],
                rect["height"],
                ffmpeg_bin=ffmpeg_bin,
                fit=fit,
                letterbox_color=color,
                crop=source_crop,
            )
            actual = _ffmpeg_crop_rgb(page_path, rect, ffmpeg_bin)
            stats = _compare_rgb(expected, actual)
            stats["slot"] = sample["slot"]
            report["pixelChecks"].append(stats)
            # PNG composition should be effectively exact; JPEG gets a loose
            # threshold because q=3 still introduces compression error.
            mean_limit = 8.0 if lossy_pages else 1.5
            bad_limit = 0.03 if lossy_pages else 0.002
            if stats["meanChannelDiff"] > mean_limit or stats["badPixelFraction"] > bad_limit:
                report["errors"].append({
                    "code": "PIXEL_MISMATCH",
                    "slot": sample["slot"],
                    "message": f"slot {sample['slot']} differs from re-extracted frame {sample['source']['frameIndex']}: {stats}",
                })
        except Exception as exc:
            report["errors"].append({
                "code": "PIXEL_CHECK_FAILED",
                "slot": sample["slot"],
                "message": str(exc),
            })
