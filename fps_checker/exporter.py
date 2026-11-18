"""CFR mp4 导出与帧对应清单。"""
from __future__ import annotations

import csv
import json
import os

from . import ffmpeg_utils
from .mapping import MappingResult
from .probe import InputVideo


def _audio_path_for(video: InputVideo, work_dir: str) -> str | None:
    """抽取原音频。无音频流返回 None。"""
    audio = os.path.join(work_dir, "audio.m4a")
    ok = ffmpeg_utils.extract_audio(video.path, audio)
    return audio if ok else None


def write_manifest(
    mapping: MappingResult,
    out_csv: str,
    *,
    source_path: str,
) -> None:
    """写出帧对应清单 CSV, 时间戳严格递增。"""
    with open(out_csv, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow([
            "output_index", "output_time_s", "request_time_s",
            "source_index", "source_time_s", "source_raw_pts_s",
            "repeated_from_previous", "gap_before_selected_s",
            "gap_to_next_source_s",
        ])
        prev_t = None
        for f in mapping.frames:
            # 导出时再做一次硬校验, 杜绝任何非递增时间戳漏出
            if prev_t is not None and f.out_time <= prev_t:
                raise RuntimeError("输出时间戳不满足严格递增, 导出中止")
            prev_t = f.out_time
            w.writerow([
                f.index,
                f"{f.out_time:.6f}",
                f"{f.request_time:.6f}",
                f.source_index,
                f"{f.source_time:.6f}",
                f"{f.source_raw_time:.6f}",
                "1" if f.repeated else "0",
                f"{f.gap_before:.6f}",
                "" if f.gap_after is None else f"{f.gap_after:.6f}",
            ])


def write_summary(mapping: MappingResult, source: InputVideo,
                  out_json: str, output_mp4: str) -> None:
    """写出规则与统计摘要 JSON, 与清单互相印证。"""
    payload = {
        "source_file": source.path,
        "output_file": output_mp4,
        "fps": mapping.fps,
        "rule": "floor: 选取不晚于请求时间 k/fps 的最近源帧; "
                "总帧数 floor(source_span*fps)+1",
        "source": {
            "frame_count": source.frame_count,
            "is_vfr": source.is_vfr,
            "zero_time": source.zero_ts,
            "raw_pts": source.raw_pts,
            "span_seconds": source.source_span,
        },
        "output": {
            "frame_count": mapping.output_count,
            "span_seconds": mapping.output_span,
            "expected_interval": 1.0 / mapping.fps,
            "repeat_frames": mapping.repeat_count,
            "unused_source_frames": mapping.unused_indices,
            "duration_diff_seconds": mapping.duration_diff,
        },
        "frames": [
            {
                "output_index": f.index,
                "output_time_s": round(f.out_time, 6),
                "source_index": f.source_index,
                "source_time_s": round(f.source_time, 6),
                "source_raw_pts_s": round(f.source_raw_time, 6),
                "repeated": f.repeated,
            }
            for f in mapping.frames
        ],
    }
    with open(out_json, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)


def export(
    source: InputVideo,
    mapping: MappingResult,
    out_dir: str,
    base_name: str,
    *,
    with_audio: bool = True,
    on_progress=None,
) -> dict[str, str]:
    """导出 mp4 + 清单 CSV + 摘要 JSON, 返回文件路径字典。"""
    os.makedirs(out_dir, exist_ok=True)
    mp4 = os.path.join(out_dir, f"{base_name}.mp4")
    csv_path = os.path.join(out_dir, f"{base_name}_mapping.csv")
    json_path = os.path.join(out_dir, f"{base_name}_mapping.json")

    ordered = [source.frame_files[f.source_index] for f in mapping.frames]
    audio = _audio_path_for(source, source.work_dir) if with_audio else None
    ffmpeg_utils.encode_pipe(
        ordered, mapping.fps, mp4,
        audio_path=audio, on_progress=on_progress,
    )
    write_manifest(mapping, csv_path, source_path=source.path)
    write_summary(mapping, source, json_path, mp4)
    return {"mp4": mp4, "csv": csv_path, "json": json_path}
