"""检测结果的标注持久化与导出(CSV/JSON/截图/切片)。"""

from __future__ import annotations

import csv
import json
import os
import re
import subprocess
from typing import Dict, Iterable, List, Optional

from .detect import AnalysisResult, Segment, format_timecode
from .timeline import FFmpegError, VideoTimeline, require_binary

ANNOTATION_FIELDS = ("label", "note", "auto_kind_at_save", "duration_ms_at_save")


def _strip_ext(path: str) -> str:
    name = os.path.basename(path)
    return os.path.splitext(name)[0]


def _safe_name(name: str) -> str:
    name = re.sub(r"[^\w\-.一-鿿]+", "_", name)
    return name.strip("_") or "video"


class AnnotationStore:
    """按视频文件名保存人工标注，复检时自动合并。

    标注以段的起止毫秒为键。视频内容不变时键稳定；若重新检测后阈值变化导致
    段的边界变化，会按时间重叠度把旧标注迁移到新段上。
    """

    def __init__(self, path: Optional[str] = None) -> None:
        self.path = path
        self.items: Dict[str, Dict[str, str]] = {}

    @classmethod
    def default_path(cls, video_path: str) -> str:
        base, _ = os.path.splitext(video_path)
        return base + ".annotations.json"

    @classmethod
    def load(cls, video_path: str, explicit_path: Optional[str] = None) -> "AnnotationStore":
        path = explicit_path or cls.default_path(video_path)
        store = cls(path)
        if path and os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
            except (OSError, json.JSONDecodeError):
                data = {}
            items = data.get("segments") if isinstance(data, dict) else None
            if isinstance(items, dict):
                store.items = {
                    str(k): {
                        "label": str(v.get("label", "")),
                        "note": str(v.get("note", "")),
                    }
                    for k, v in items.items()
                    if isinstance(v, dict)
                }
        return store

    def save(self, video_path: str, result: Optional[AnalysisResult] = None) -> str:
        path = self.path or self.default_path(video_path)
        payload = {
            "video": video_path,
            "version": 1,
            "params": result.params.as_dict() if result else None,
            "segments": self.items,
        }
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        self.path = path
        return path

    def set(self, segment: Segment, label: str, note: str = "") -> None:
        self.items[segment.key] = {"label": label, "note": note}

    def remove(self, segment: Segment) -> None:
        self.items.pop(segment.key, None)

    def apply(self, segments: List[Segment]) -> int:
        """把标注合并到检测结果。返回成功迁移/挂上的标注条数。"""
        unmatched = set(self.items.keys())
        hit = 0
        for seg in segments:
            matched_key = seg.key if seg.key in self.items else None
            if matched_key is None:
                matched_key = self._match_overlap(seg, unmatched)
            if matched_key is not None:
                entry = self.items[matched_key]
                seg.label = entry.get("label", "")
                seg.note = entry.get("note", "")
                hit += 1
                unmatched.discard(matched_key)
        return hit

    def _match_overlap(
        self, seg: Segment, unmatched: Iterable[str]
    ) -> Optional[str]:
        best_key = None
        best_overlap = 0.0
        for key in unmatched:
            try:
                a, b = key.split(":")
                s_ms, e_ms = int(a), int(b)
            except ValueError:
                continue
            overlap = min(seg.end_ms, e_ms) - max(seg.start_ms, s_ms)
            if overlap <= 0:
                continue
            union = max(seg.end_ms, e_ms) - min(seg.start_ms, s_ms)
            iou = overlap / float(union or 1)
            if iou >= 0.3 and overlap > best_overlap:
                best_key = key
                best_overlap = overlap
        return best_key

    def prune(self, segments: List[Segment]) -> None:
        """移除不再匹配任何片段的旧标注。"""
        valid = set()
        for seg in segments:
            valid.add(seg.key)
        self.items = {k: v for k, v in self.items.items() if k in valid}


def export_csv(result: AnalysisResult, out_path: str) -> str:
    with open(out_path, "w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.writer(fh)
        writer.writerow(
            [
                "序号",
                "开始时间码",
                "结束时间码",
                "开始(ms)",
                "结束(ms)",
                "时长(ms)",
                "帧区间",
                "帧数",
                "最小相邻相似度",
                "最大锚点漂移",
                "平均亮度",
                "自动分类",
                "人工标注",
                "计入问题",
                "备注",
            ]
        )
        for i, seg in enumerate(result.segments, 1):
            writer.writerow(
                [
                    i,
                    format_timecode(seg.start_time),
                    format_timecode(seg.end_time),
                    seg.start_ms,
                    seg.end_ms,
                    seg.duration_ms,
                    f"{seg.start_frame}-{seg.end_frame}",
                    seg.frame_count,
                    f"{seg.min_step_similarity:.4f}",
                    f"{seg.max_drift:.4f}",
                    f"{seg.mean_luma:.3f}",
                    seg.kind_display,
                    seg.label_display,
                    "否" if seg.ignored else "是",
                    seg.note,
                ]
            )
    return out_path


def export_json(result: AnalysisResult, out_path: str) -> str:
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(result.to_dict(), fh, ensure_ascii=False, indent=2)
    return out_path


def export_snapshots(
    timeline: VideoTimeline,
    segments: List[Segment],
    out_dir: str,
    include_context: bool = True,
    max_width: int = 960,
) -> List[str]:
    """导出每个片段的截图。

    每个片段一张首帧(冻结画面)；可选导出前后各一帧上下文，
    方便人工快速判断"停住"前后是否正常。
    """
    os.makedirs(out_dir, exist_ok=True)
    produced: List[str] = []
    for i, seg in enumerate(segments, 1):
        jobs = [(seg.start_frame, f"{i:03d}_freeze_{_ms(seg.start_ms)}")]
        if include_context:
            if seg.context_before:
                jobs.append(
                    (
                        seg.context_before[-1].index,
                        f"{i:03d}_before_{_ms(seg.context_before[-1].start_ms)}",
                    )
                )
            if seg.context_after:
                jobs.append(
                    (
                        seg.context_after[0].index,
                        f"{i:03d}_after_{_ms(seg.context_after[0].start_ms)}",
                    )
                )
        for frame_index, name in jobs:
            path = os.path.join(out_dir, name + ".png")
            _extract_frame(timeline, frame_index, path, max_width)
            produced.append(path)
    return produced


def _ms(value: int) -> str:
    return f"{value:08d}ms"


def _seek_args(timeline: VideoTimeline, frame_index: int) -> List[str]:
    """把帧下标换算成输入侧的绝对时间与输出侧的小偏移。

    用输入侧 -ss 快速定位 + 精确帧号定位，避免 seek 精度问题。
    """
    abs_time = timeline.start_time + timeline.pts[frame_index]
    return ["-ss", f"{abs_time:.4f}"]


def _extract_frame(
    timeline: VideoTimeline, frame_index: int, out_path: str, max_width: int
) -> None:
    scale = (
        f"scale='min({max_width},iw)':-2:flags=lanczos"
        if max_width
        else "null"
    )
    abs_time = timeline.start_time + timeline.pts[frame_index]
    # 在输入侧精确定位到该帧所在时间，输出第一帧即该帧。
    cmd = [
        require_binary("ffmpeg"),
        "-hide_banner",
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-ss",
        f"{abs_time:.6f}",
        "-i",
        timeline.path,
        "-frames:v",
        "1",
        "-vf",
        scale,
        "-fps_mode",
        "passthrough",
        out_path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not os.path.exists(out_path):
        # 某些容器 seek 会找不到帧，退回解码到该帧
        cmd2 = [
            require_binary("ffmpeg"),
            "-hide_banner",
            "-v",
            "error",
            "-nostdin",
            "-y",
            "-i",
            timeline.path,
            "-vf",
            f"select='eq(n\\,{frame_index})',{scale}",
            "-frames:v",
            "1",
            "-fps_mode",
            "passthrough",
            out_path,
        ]
        p2 = subprocess.run(cmd2, capture_output=True, text=True)
        if p2.returncode != 0 or not os.path.exists(out_path):
            raise FFmpegError(
                f"导出截图失败(帧 {frame_index}): {(p2.stderr or proc.stderr).strip()[-300:]}"
            )


def export_clips(
    timeline: VideoTimeline,
    segments: List[Segment],
    out_dir: str,
    padding_ms: int = 150,
) -> List[str]:
    """按片段时间范围导出切片(含前后 padding，便于人工复核)。

    时间范围取自逐帧 PTS，慢速变化/不等间隔视频同样适用。
    """
    os.makedirs(out_dir, exist_ok=True)
    produced: List[str] = []
    for i, seg in enumerate(segments, 1):
        start = max(0.0, seg.start_time - padding_ms / 1000.0)
        end = min(timeline.duration, seg.end_time + padding_ms / 1000.0)
        abs_start = timeline.start_time + start
        dur = max(0.05, end - start)
        name = (
            f"{i:03d}_{seg.kind_display}_{_ms(seg.start_ms)}"
            f"-{_ms(seg.end_ms)}.mp4"
        )
        out = os.path.join(out_dir, name)
        cmd = [
            require_binary("ffmpeg"),
            "-hide_banner",
            "-v",
            "error",
            "-nostdin",
            "-y",
            "-ss",
            f"{abs_start:.6f}",
            "-i",
            timeline.path,
            "-t",
            f"{dur:.6f}",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-an",
            out,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0 or not os.path.exists(out):
            raise FFmpegError(f"导出切片失败: {proc.stderr.strip()[-300:]}")
        produced.append(out)
    return produced


def export_report(
    result: AnalysisResult,
    out_dir: str,
    snapshots: bool = True,
    clips: bool = False,
) -> Dict[str, object]:
    """一次性导出 CSV + JSON + 截图(可选切片)，返回产物路径。"""
    os.makedirs(out_dir, exist_ok=True)
    stem = _safe_name(_strip_ext(result.timeline.path))
    csv_path = export_csv(result, os.path.join(out_dir, stem + ".freeze.csv"))
    json_path = export_json(result, os.path.join(out_dir, stem + ".freeze.json"))
    shot_dir = os.path.join(out_dir, stem + ".frames")
    shot_paths: List[str] = []
    if snapshots and result.segments:
        shot_paths = export_snapshots(result.timeline, result.segments, shot_dir)
    clip_paths: List[str] = []
    if clips and result.segments:
        clip_paths = export_clips(
            result.timeline, result.segments, os.path.join(out_dir, stem + ".clips")
        )
    return {
        "csv": csv_path,
        "json": json_path,
        "snapshots": shot_paths,
        "clips": clip_paths,
    }
