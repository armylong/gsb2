"""图片导入校验与结果导出。

导出三件套（同名不同后缀）：
- ``*.png``        删缝后的真实结果图；
- ``*_map.npz``    源 -> 结果的像素对应记录，显式包含被删源像素；
- ``*_meta.json``  实际尺寸、目标尺寸、删除数量、停止原因等元数据。
"""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

from .engine import CarveOutcome, infeasible_reason

SIDE_MIN, SIDE_MAX = 200, 1000
TARGET_RATIO_MIN = 0.75


class ImageLoadError(ValueError):
    """导入图片不符合约定时抛出。"""


def load_image(path: str | Path) -> np.ndarray:
    """导入普通不透明 PNG/JPEG，返回 uint8 BGR (H, W, 3)。

    校验：文件能读、宽高均在 200~1000、3 通道、若带 alpha 则必须完全不透明。
    """
    path = Path(path)
    if not path.is_file():
        raise ImageLoadError(f"文件不存在：{path}")
    if path.suffix.lower() not in (".png", ".jpg", ".jpeg"):
        raise ImageLoadError("只支持 .png / .jpg / .jpeg 文件")

    # IMAGE_UNCHANGED 保留 alpha，便于检查“不透明”约束。
    raw = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if raw is None:
        raise ImageLoadError(f"OpenCV 无法解码该文件：{path}")
    if raw.ndim not in (2, 3):
        raise ImageLoadError("无法识别的图像数据维度")

    if raw.ndim == 2:
        image = cv2.cvtColor(raw, cv2.COLOR_GRAY2BGR)
    elif raw.shape[2] == 4:
        alpha = raw[:, :, 3]
        if bool(np.any(alpha < 255)):
            raise ImageLoadError("只支持不透明图片：检测到 alpha 通道含透明像素")
        image = cv2.cvtColor(raw, cv2.COLOR_BGRA2BGR)
    elif raw.shape[2] == 3:
        image = raw
    else:
        raise ImageLoadError(f"不支持的通道数：{raw.shape[2]}")

    h, w = image.shape[:2]
    if not (SIDE_MIN <= w <= SIDE_MAX and SIDE_MIN <= h <= SIDE_MAX):
        raise ImageLoadError(
            f"宽高需分别在 {SIDE_MIN}~{SIDE_MAX} 像素之间，实际为 {w}×{h}"
        )
    return np.ascontiguousarray(image)


def export_result(outcome: CarveOutcome, base_path: str | Path) -> dict[str, Path]:
    """导出结果图、像素对应记录和元数据，返回各文件路径。"""
    base = Path(base_path)
    base.parent.mkdir(parents=True, exist_ok=True)
    png_path = base.with_suffix(".png")
    map_path = base.with_name(base.name + "_map.npz")
    meta_path = base.with_name(base.name + "_meta.json")

    # 1) 真实结果图
    ok = cv2.imwrite(str(png_path), outcome.result)
    if not ok:
        raise OSError(f"结果图写入失败：{png_path}")

    # 2) 像素对应记录（npz，显式表达已删除像素）
    src_w = outcome.source_width
    removed = np.asarray(
        outcome.removed_source_points, dtype=np.int32
    ).reshape(-1, 2)
    # source_status: 每个源像素的去向。0=保留, 1=已删除
    source_status = np.zeros((outcome.height, src_w), dtype=np.uint8)
    if removed.size:
        source_status[removed[:, 0], removed[:, 1]] = 1
    # result_to_source: 结果图每个像素对应的源图列号（行号不变）
    np.savez_compressed(
        map_path,
        result_to_source=outcome.source_index.astype(np.int32),
        source_status=source_status,
        removed_points=removed,
        source_height=np.int32(outcome.height),
        source_width=np.int32(src_w),
        result_height=np.int32(outcome.height),
        result_width=np.int32(outcome.width),
    )

    # 3) 元数据 JSON
    meta = {
        "target_width": outcome.target_width,
        "actual_width": outcome.width,
        "height": outcome.height,
        "source_width": src_w,
        "completed": outcome.completed,
        "cancelled": outcome.cancelled,
        "stopped_infeasible": outcome.stopped_infeasible,
        "remaining_to_target": outcome.remaining,
        "removed_pixel_count": len(outcome.removed_source_points),
        "removed_seam_count": len(outcome.removed_seams),
        "reason": infeasible_reason(outcome),
        "result_png": png_path.name,
        "mapping_npz": map_path.name,
    }
    meta_path.write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return {"png": png_path, "map": map_path, "meta": meta_path}
