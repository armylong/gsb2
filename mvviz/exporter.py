"""帧图像与向量数据的导出。"""

from __future__ import annotations

import json
from pathlib import Path

from .groundtruth import GroundTruth
from .mvdata import VideoData
from .render import render_overlay


def export_frame_vectors(video: VideoData, gt: GroundTruth | None,
                         frame_range: range) -> dict:
    """导出一组帧的完整向量数据（不做显示筛选，保留原始数据）。"""
    out_frames = []
    for i in frame_range:
        fi = video.frame_info[i]
        vectors = [v.to_dict() for v in fi.vectors]
        if gt is not None:
            for v, raw in zip(fi.vectors, vectors):
                verdict, exp = gt.compare(i, v)
                raw["comparison"] = {
                    "verdict": verdict,
                    "expectation_kind": exp.kind,
                    "expected_motion_px": [round(exp.exp_mv_x, 3), round(exp.exp_mv_y, 3)],
                    "object": exp.object_name,
                    "reason": exp.reason,
                }
        out_frames.append({
            "frame": i,
            "pict_type": fi.pict_type,
            "status": fi.status_text(),
            "vectors": vectors,
        })
    return {
        "source_video": video.path,
        "frame_count": video.frame_count,
        "note": "向量为编码器导出的完整原始数据，未按长度/方向做显示筛选。",
        "frames": out_frames,
    }


def save_frame_vectors(path: str | Path, video: VideoData,
                       gt: GroundTruth | None, frame_range: range) -> Path:
    path = Path(path)
    path.write_text(json.dumps(
        export_frame_vectors(video, gt, frame_range), ensure_ascii=False, indent=1))
    return path


def save_frame_image(path: str | Path, video: VideoData, gt: GroundTruth | None,
                     index: int, settings) -> Path:
    """按当前显示设置导出某一帧的叠加 PNG。"""
    fi = video.frame_info[index]
    img = render_overlay(
        video.get_frame(index), fi.vectors, gt, index,
        min_length=settings.min_length,
        show_past=settings.show_past,
        show_future=settings.show_future,
        show_blocks=settings.show_blocks,
        show_expected=settings.show_expected,
        show_mismatch=settings.show_mismatch,
    )
    path = Path(path)
    img.save(path)
    return path
