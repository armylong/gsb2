"""分析与渲染主管线。

分析(运动估计)结果可缓存, 调平滑参数时只重算几何, 保证路径/画面/裁切
始终来自同一套参数, 不残留旧结果。预览与导出共用同一个 full_warps。
"""
from __future__ import annotations

import json
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from . import geometry as geom
from . import media, motion

SIDECAR_VERSION = 1
SIDECAR_META_KEY = "comment"
COLOR_WARN = (0, 165, 255)     # BGR 橙
COLOR_VALID = (80, 230, 80)    # 绿: 逐帧有效边界
COLOR_SAFE = (255, 180, 0)     # 蓝: 镜头统一安全框
COLOR_SAMPLE = (0, 220, 255)   # 黄: 实际采样区域
FONT = cv2.FONT_HERSHEY_SIMPLEX


@dataclass
class AnalysisCache:
    video_path: str
    info: media.VideoInfo
    motions: motion.MotionResult

    def to_payload(self) -> dict:
        m = self.motions
        return {
            "frame_count": self.info.frame_count,
            "fps": self.info.fps,
            "width": self.info.width,
            "height": self.info.height,
            "has_audio": self.info.has_audio,
            "duration": self.info.duration,
            "auto_cuts": m.auto_cuts,
            "gray_diffs": m.gray_diffs.round(3).tolist(),
            "inlier_ratios": m.inlier_ratios.round(3).tolist(),
        }


def analyze_video(video_path: str | Path, progress_cb=None) -> AnalysisCache:
    info = media.probe(video_path)
    motions = motion.estimate_motions(
        str(video_path), info.frame_count, progress_cb=progress_cb,
    )
    return AnalysisCache(video_path=str(video_path), info=info, motions=motions)


def compute(cache: AnalysisCache, cuts: list[int], sigma: float
            ) -> tuple[np.ndarray, geom.Geometry]:
    cuts = motion.validate_cuts(cuts, cache.info.frame_count)
    shot_starts = [0] + cuts
    return geom.analyze(
        cache.motions.affines, shot_starts,
        cache.info.width, cache.info.height,
        cache.info.frame_count, sigma,
    )


def _draw_overlay(frame: np.ndarray, geo: geom.Geometry, idx: int,
                  shot_idx: int, show_safe: bool, show_sample: bool) -> None:
    cv2.polylines(frame, [geo.valid_quads[idx].astype(np.int32)],
                  True, COLOR_VALID, 2)
    if show_sample:
        cv2.polylines(frame, [geo.sample_boxes[idx].astype(np.int32)],
                      True, COLOR_SAMPLE, 2)
    if show_safe:
        x1, y1, x2, y2 = geo.shot_safe_rects[shot_idx].astype(int)
        cv2.rectangle(frame, (x1, y1), (x2, y2), COLOR_SAFE, 2)
    cv2.putText(frame, f"frame {idx}", (12, 26), FONT, 0.7,
                (255, 255, 255), 3, cv2.LINE_AA)
    cv2.putText(frame, f"frame {idx}", (12, 26), FONT, 0.7,
                (20, 20, 20), 1, cv2.LINE_AA)


def render_video(cache: AnalysisCache, geo: geom.Geometry, cuts: list[int],
                 out_path: str | Path, *, preview: bool,
                 draw_overlay: bool = True, progress_cb=None) -> Path:
    """按 geo.full_warps 逐帧渲染。preview=True 输出半分辨率便于网页预览。

    最终导出(preview=False)与预览使用完全相同的变换矩阵与裁切比例。
    """
    info = cache.info
    cuts = motion.validate_cuts(cuts, info.frame_count)
    starts = [0] + cuts
    ends = cuts + [info.frame_count]
    shot_of = np.empty(info.frame_count, dtype=int)
    for k, (s, e) in enumerate(zip(starts, ends)):
        shot_of[s:e] = k

    if preview:
        out_w, out_h = info.width // 2, info.height // 2
        bitrate = max(1_200_000, info.width * info.height * 4)
    else:
        out_w, out_h = info.width, info.height
        bitrate = max(4_000_000, info.width * info.height * 10)

    cap = cv2.VideoCapture(cache.video_path)
    if not cap.isOpened():
        raise RuntimeError("渲染时无法重新打开源视频")

    with tempfile.TemporaryDirectory() as td:
        silent = Path(td) / "silent.mp4"
        writer = cv2.VideoWriter(
            str(silent), cv2.VideoWriter_fourcc(*"mp4v"),
            info.fps, (out_w, out_h),
        )
        if not writer.isOpened():
            raise RuntimeError("VideoWriter 初始化失败")
        for i in range(info.frame_count):
            ok, frame = cap.read()
            if not ok:
                raise RuntimeError(f"渲染时第 {i} 帧读取失败")
            warped = cv2.warpAffine(
                frame, geo.full_warps[i], (info.width, info.height),
                flags=cv2.INTER_LINEAR,
                borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0),
            )
            if preview:
                shown = cv2.resize(warped, (out_w, out_h),
                                   interpolation=cv2.INTER_AREA)
                if draw_overlay:
                    # 叠加在缩小后的画面上, 坐标按比例缩放
                    scale = out_w / info.width
                    small_geo = _scale_geometry(geo, scale)
                    _draw_overlay(shown, small_geo, i, int(shot_of[i]),
                                  show_safe=True, show_sample=False)
            else:
                shown = warped
            writer.write(shown)
            if progress_cb and (i % 10 == 0 or i == info.frame_count - 1):
                progress_cb(i + 1, info.frame_count)
        writer.release()
        cap.release()

        out_path = Path(out_path)
        # 统一转 H.264/yuv420p 保证浏览器可播, 再封装原音频
        transcoded = Path(td) / "h264.mp4"
        cmd = [
            "ffmpeg", "-y", "-v", "error", "-i", str(silent),
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-b:v", str(bitrate), "-preset", "medium", str(transcoded),
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:
            raise RuntimeError(f"预览转码失败: {res.stderr[:300]}")

        audio_path = Path(td) / "audio.m4a"
        audio = audio_path if media.extract_audio(cache.video_path, audio_path) \
            else None
        media.mux_video_audio(transcoded, audio, out_path)
    return out_path


def _scale_geometry(geo: geom.Geometry, s: float) -> geom.Geometry:
    g = geom.Geometry(
        corrections=geo.corrections,
        full_warps=geo.full_warps,
        valid_quads=geo.valid_quads * s,
        inner_rects=geo.inner_rects * s,
        shot_zoom=geo.shot_zoom,
        shot_safe_rects=geo.shot_safe_rects * s,
        retained_ratio=geo.retained_ratio,
        sample_boxes=geo.sample_boxes * s,
        params_raw=geo.params_raw,
        params_smooth=geo.params_smooth,
    )
    return g


def build_sidecar(cache: AnalysisCache, geo: geom.Geometry, cuts: list[int],
                  sigma: float, output_path: str) -> dict:
    """生成随输出视频保存的核对元数据。"""
    info = cache.info
    cuts = motion.validate_cuts(cuts, info.frame_count)
    starts = [0] + cuts
    ends = cuts + [info.frame_count]
    shots = []
    for k, (s, e) in enumerate(zip(starts, ends)):
        shots.append({
            "index": k,
            "start_frame": s,
            "end_frame_exclusive": e,
            "uniform_zoom": round(float(geo.shot_zoom[k]), 5),
            "safe_crop_rect": [round(float(v), 2)
                               for v in geo.shot_safe_rects[k]],
            "retained_area_ratio": round(float(geo.retained_ratio[k]), 4),
            "below_warn_threshold": bool(
                geo.retained_ratio[k] < geom.RETAIN_WARN_RATIO),
        })
    return {
        "sidecar_version": SIDECAR_VERSION,
        "source_video": Path(cache.video_path).name,
        "output_video": Path(output_path).name,
        "params": {"sigma_frames": float(sigma), "cut_frames": cuts},
        "video": {
            "width": info.width, "height": info.height,
            "fps": info.fps, "frame_count": info.frame_count,
            "duration": round(info.duration, 4),
            "has_audio": info.has_audio,
        },
        "shots": shots,
        "warn_retained_ratio_below": geom.RETAIN_WARN_RATIO,
        "frames": [
            {
                "frame": i,
                "shot": int(np.searchsorted(np.asarray([0] + cuts), i,
                                            side="right") - 1),
                "valid_quad": geo.valid_quads[i].round(2).tolist(),
                "safe_crop_rect": geo.shot_safe_rects[
                    int(np.searchsorted(np.asarray([0] + cuts), i,
                                        side="right") - 1)
                ].round(2).tolist(),
                "sample_quad": geo.sample_boxes[i].round(2).tolist(),
                "path_raw": {
                    "tx": round(float(geo.params_raw["tx"][i]), 3),
                    "ty": round(float(geo.params_raw["ty"][i]), 3),
                    "angle": round(float(geo.params_raw["angle"][i]), 4),
                },
                "path_smooth": {
                    "tx": round(float(geo.params_smooth["tx"][i]), 3),
                    "ty": round(float(geo.params_smooth["ty"][i]), 3),
                    "angle": round(float(geo.params_smooth["angle"][i]), 4),
                },
            }
            for i in range(info.frame_count)
        ],
    }


def save_sidecar(sidecar: dict, path: str | Path) -> Path:
    path = Path(path)
    path.write_text(json.dumps(sidecar, ensure_ascii=False, indent=1),
                    encoding="utf-8")
    return path
