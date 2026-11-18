"""导出校正后像素图与参数、控制点记录。"""

from __future__ import annotations

import json
from pathlib import Path
import numpy as np
import cv2

from .distortion import DistortionParams
from .cropping import CropRect, crop_info_text


def export_corrected_image(path: str | Path,
                           corrected: np.ndarray,
                           valid_mask: np.ndarray,
                           crop: CropRect | None,
                           crop_mode: str) -> tuple[int, int]:
    """导出真实像素图（不含界面边框）。

    crop_mode:
      ``"full"`` 保留完整画幅；``"crop"`` 裁去无效边缘。
    越界像素统一写成黑色 (0,0,0)，返回导出尺寸 (w,h)。
    """
    if crop_mode == "crop" and crop is not None:
        out_img = corrected[crop.y:crop.bottom, crop.x:crop.right].copy()
        out_mask = valid_mask[crop.y:crop.bottom, crop.x:crop.right]
    else:
        out_img = corrected.copy()
        out_mask = valid_mask

    out_img = out_img.copy()
    out_img[~out_mask] = 0
    # cv2 写 BGR；输入即 BGR
    ok = cv2.imwrite(str(path), out_img)
    if not ok:
        raise OSError(f"图像写入失败：{path}")
    h, w = out_img.shape[:2]
    return w, h


def export_record(path: str | Path, record: dict) -> None:
    """导出 JSON 参数/控制点记录（numpy 类型已在构建时转成原生类型）。"""
    Path(path).write_text(
        json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")


def build_record(*, source_name: str, source_size: tuple[int, int],
                 params: DistortionParams,
                 norm_s: float,
                 control_points: list[dict],
                 fit_mode: str,
                 fit_summary: dict | None,
                 crop_mode: str,
                 crop: CropRect | None,
                 export_size: tuple[int, int]) -> dict:
    """构建与预览一致的导出记录字典。"""
    return {
        "format_version": 1,
        "source": {
            "name": source_name,
            "width": int(source_size[0]),
            "height": int(source_size[1]),
            "coordinate_system": (
                "像素坐标，原点在左上角，u 向右、v 向下；"
                "归一化坐标 x=(u-cx)/s, y=(v-cy)/s，s 为画幅半对角线"),
            "norm_scale_s": norm_s,
        },
        "distortion_model": {
            "convention": "OpenCV k1,k2,p1,p2",
            "k1": float(params.k1),
            "k2": float(params.k2),
            "p1": float(params.p1),
            "p2": float(params.p2),
            "cx_px": float(params.cx),
            "cy_px": float(params.cy),
            "units": "cx/cy 为像素，k1/k2/p1/p2 为无量纲系数",
            "sign_note": ("k1<0 桶形，k1>0 枕形；零参数为恒等映射；"
                          "正向与反向使用同一套参数"),
        },
        "fit": {
            "mode": fit_mode,
            "center_fixed": True,
            "summary": fit_summary,
        },
        "control_points": control_points,
        "crop": {
            "mode": crop_mode,
            "rect": None if crop is None else {
                "x": crop.x, "y": crop.y,
                "width": crop.width, "height": crop.height,
                "description": crop_info_text(crop),
            },
            "export_size_wh": [int(export_size[0]), int(export_size[1])],
        },
    }


def control_point_records(points: list, residual_dist: np.ndarray | None
                          ) -> list[dict]:
    """把界面控制点转成可序列化记录。points 元素需有 index/target/observed。"""
    records = []
    for i, cp in enumerate(points):
        rec = {
            "index": cp.index,
            "target_uv_px": [float(cp.target[0]), float(cp.target[1])],
            "observed_uv_px": [float(cp.observed[0]), float(cp.observed[1])],
        }
        if residual_dist is not None and i < len(residual_dist):
            rec["residual_px"] = float(residual_dist[i])
        records.append(rec)
    return records
