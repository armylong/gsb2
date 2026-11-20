"""图像导入与结果导出工具。"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from .geometry import FILL_VALUE, overlap_mask, warp_align


def load_gray(path: str | Path) -> np.ndarray:
    """以灰度方式读图。"""
    data = np.fromfile(str(path), dtype=np.uint8)  # 兼容中文路径
    if data.size == 0:
        raise ValueError(f"无法读取图像: {path}")
    img = cv2.imdecode(data, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError(f"文件不是有效图像: {path}")
    return img


def save_gray(path: str | Path, img: np.ndarray) -> None:
    """保存灰度图（兼容中文路径）。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    ok, buf = cv2.imencode(path.suffix or ".png", img)
    if not ok:
        raise RuntimeError(f"编码失败: {path}")
    buf.tofile(str(path))


def build_export(
    ref: np.ndarray,
    moving: np.ndarray,
    dx: float,
    dy: float,
) -> dict[str, np.ndarray]:
    """生成一组导出产物。

    aligned.png   : moving 反向 warp 后的对齐图（边缘为填充值）
    valid_mask.png: 实际重叠区域掩码（255=有效，0=边缘填充）
    residual.png  : 残差可视化（有效区按幅值着色，填充区纯黑）
    overlay.png   : ref 与对齐图的红绿叠加（ref=红，aligned=绿）
    """
    aligned = warp_align(moving, dx, dy)
    valid = overlap_mask(ref.shape[:2], dx, dy)
    mask_u8 = (valid.astype(np.uint8)) * 255

    diff = np.zeros_like(ref, dtype=np.float32)
    diff[valid] = aligned.astype(np.float32)[valid] - ref.astype(np.float32)[valid]
    abs_d = np.abs(diff)
    norm = np.zeros_like(ref, dtype=np.uint8)
    if abs_d.max() > 0:
        norm = np.clip(abs_d / max(abs_d.max(), 1.0) * 255, 0, 255).astype(np.uint8)
    residual_color = cv2.applyColorMap(norm, cv2.COLORMAP_JET)
    residual_color[~valid] = 0

    overlay = np.zeros((ref.shape[0], ref.shape[1], 3), dtype=np.uint8)
    overlay[..., 2] = ref          # BGR: 红通道放 ref
    overlay[..., 1] = aligned      # 绿通道放对齐后的 moving
    overlay[~valid] = (0, 0, 255)  # 非重叠区用红色标出

    return {
        "aligned": aligned,
        "valid_mask": mask_u8,
        "residual": residual_color,
        "overlay": overlay,
    }


def export_bundle(
    out_dir: str | Path,
    ref: np.ndarray,
    moving: np.ndarray,
    dx: float,
    dy: float,
) -> dict[str, Path]:
    """把导出产物写到目录，返回各文件路径。"""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    bundle = build_export(ref, moving, dx, dy)
    paths: dict[str, Path] = {}
    suffix_map = {
        "aligned": ".png",
        "valid_mask": ".png",
        "residual": ".png",
        "overlay": ".png",
    }
    for name, img in bundle.items():
        p = out_dir / f"{name}{suffix_map[name]}"
        if img.ndim == 2:
            save_gray(p, img)
        else:
            p.parent.mkdir(parents=True, exist_ok=True)
            ok, buf = cv2.imencode(".png", img)
            if not ok:
                raise RuntimeError(f"编码失败: {p}")
            buf.tofile(str(p))
        paths[name] = p
    return paths
