"""导出：原尺寸标签数值图、区域 CSV、带编号检查 PNG。

标签规则：背景为 0，区域编号与界面表格完全一致（1..N，按最上方再最左方）。
所有真实区域都写入标签，无论是否被筛掉；是否计入及原因只体现在 CSV/表格中。
"""
from __future__ import annotations

import csv
import os
from pathlib import Path

import cv2
import numpy as np

from .models import SegmentationResult

CSV_FIELDS = [
    "编号", "面积(px)", "质心X", "质心Y",
    "外接矩形X", "外接矩形Y", "外接矩形宽", "外接矩形高",
    "触边", "孔洞数", "孔洞面积(px)", "是否计入", "排除原因",
]

# 尽量区分相邻区域的固定调色板（BGR）
PALETTE = np.array([
    [60, 76, 231], [113, 204, 46], [34, 126, 230], [133, 128, 60],
    [34, 197, 94], [240, 128, 128], [60, 180, 210], [180, 105, 255],
    [94, 197, 34], [31, 161, 219], [210, 180, 60], [94, 34, 197],
], dtype=np.uint8)


def ensure_dir(path: str | os.PathLike) -> Path:
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


def label_image(result: SegmentationResult) -> np.ndarray:
    """原尺寸、原编号的 uint16 标签图；背景 0。"""
    return result.labels.astype(np.uint16)


def write_label_png(result: SegmentationResult, path: str | os.PathLike) -> Path:
    """16 位灰度 PNG 标签图（0 背景，1..N 与表格一致）。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    ok = cv2.imwrite(str(path), label_image(result))
    if not ok:
        raise OSError(f"无法写入 {path}")
    return path


def write_label_tiff(result: SegmentationResult, path: str | os.PathLike) -> Path:
    """16 位 TIFF 标签图；部分脚本对 TIFF 支持更稳定，与 PNG 内容相同。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    ok = cv2.imwrite(str(path), label_image(result))
    if not ok:
        raise OSError(f"无法写入 {path}")
    return path


def write_region_csv(result: SegmentationResult, path: str | os.PathLike,
                     image_info: dict | None = None) -> Path:
    """全部区域（含被筛掉的）逐行写出，并在末尾写汇总行。

    UTF-8 BOM 便于 Excel 直接打开中文表头。
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for rec in result.regions:
            writer.writerow(rec.to_row())
        writer.writerow({})
        if image_info:
            writer.writerow({"编号": "# 图像", "面积(px)": image_info.get("path", "")})
            writer.writerow({"编号": "# 尺寸(宽x高)",
                             "面积(px)": f"{result.labels.shape[1]}x{result.labels.shape[0]}"})
        writer.writerow({"编号": "# 全部区域数", "面积(px)": result.total_count})
        writer.writerow({"编号": "# 计入区域数", "面积(px)": result.included_count})
        writer.writerow({"编号": "# 计入总面积(px)", "面积(px)": result.included_area})
        writer.writerow({"编号": "# 筛除区域数", "面积(px)": result.total_count - result.included_count})
        writer.writerow({"编号": "# 筛除总面积(px)",
                         "面积(px)": sum(r.stats.area for r in result.regions if not r.included)})
        t = result.params.threshold
        writer.writerow({"编号": "# 阈值", "排除原因": t.describe()})
        writer.writerow({"编号": "# 邻接", "排除原因": f"{result.params.connectivity.value} 邻接"})
        writer.writerow({"编号": "# 去噪半径", "排除原因": result.params.despeckle_radius})
        writer.writerow({"编号": "# 填隙半径", "排除原因": result.params.fill_radius})
    return path


def render_inspection(result: SegmentationResult, image_bgr: np.ndarray,
                      font_scale: float | None = None) -> np.ndarray:
    """带编号的检查图。

    - 所有区域（含被筛掉的）都画编号；计入区域彩色半透明填充，
      被筛掉的区域红色半透明填充并在编号后加 ``(excluded)``。
    - 孔洞用青色描边。
    - 编号画在区域外接矩形上方，避免被小孔或细线遮挡；字号随图像尺寸自适应。
    - OpenCV 内置字体不含中文，标签统一用 ASCII，保证任何环境都能显示。
    """
    h, w = result.labels.shape
    if image_bgr.ndim == 2:
        base = cv2.cvtColor(image_bgr, cv2.COLOR_GRAY2BGR)
    else:
        base = image_bgr.copy()
    if base.shape[:2] != (h, w):
        base = cv2.resize(base, (w, h), interpolation=cv2.INTER_NEAREST)
    out = base.copy()
    if font_scale is None:
        font_scale = float(np.clip(min(h, w) / 700.0, 0.4, 1.1))
    thickness = 1 if font_scale < 0.8 else 2

    # 先铺半透明色块，再画轮廓和文字，避免轮廓被后铺的色块盖住
    for rec in result.regions:
        comp = (result.labels == rec.stats.label_id)
        if not comp.any():
            continue
        tint = np.zeros_like(out)
        if rec.included:
            tint[comp] = PALETTE[(rec.stats.label_id - 1) % len(PALETTE)].tolist()
            out = cv2.addWeighted(out, 1.0, tint, 0.45, 0)
        else:
            tint[comp] = (60, 60, 215)
            out = cv2.addWeighted(out, 1.0, tint, 0.35, 0)

    for rec in result.regions:
        lab = rec.stats.label_id
        comp = (result.labels == lab).astype(np.uint8)
        if not comp.any():
            continue
        color = (30, 30, 220) if not rec.included else PALETTE[(lab - 1) % len(PALETTE)].tolist()
        contours, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(out, contours, -1, color, thickness, cv2.LINE_AA)
        x, y, _bw, _bh = rec.stats.bbox
        text = str(lab) if rec.included else f"{lab}(excluded)"
        (tw, th), baseline = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, font_scale, thickness)
        tx = int(np.clip(x, 1, max(1, w - tw - 2)))
        ty = y - 4 if y - 4 - th >= 0 else min(h - baseline - 1, y + th + 4)
        cv2.putText(out, text, (tx, ty), cv2.FONT_HERSHEY_SIMPLEX, font_scale,
                    (255, 255, 255), thickness + 2, cv2.LINE_AA)
        cv2.putText(out, text, (tx, ty), cv2.FONT_HERSHEY_SIMPLEX, font_scale,
                    color, thickness, cv2.LINE_AA)

    if result.hole_mask is not None and result.hole_mask.any():
        contours, _ = cv2.findContours(result.hole_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(out, contours, -1, (230, 200, 0), thickness, cv2.LINE_AA)

    return out


def export_all(result: SegmentationResult, image_bgr: np.ndarray, out_dir: str | os.PathLike,
               stem: str = "segmentation", image_info: dict | None = None) -> dict[str, Path]:
    """按约定文件名导出三类结果，返回路径字典。"""
    out = ensure_dir(out_dir)
    stem = stem or "segmentation"
    return {
        "label_png": write_label_png(result, out / f"{stem}_labels.png"),
        "label_tif": write_label_tiff(result, out / f"{stem}_labels.tif"),
        "csv": write_region_csv(result, out / f"{stem}_regions.csv", image_info),
        "inspection": _write_png(render_inspection(result, image_bgr), out / f"{stem}_inspection.png"),
    }


def _write_png(img: np.ndarray, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    ok = cv2.imwrite(str(path), img)
    if not ok:
        raise OSError(f"无法写入 {path}")
    return path


def read_label_png(path: str | os.PathLike) -> np.ndarray:
    """回读标签图并返回 int32 标签场；用于测试与外部校验。"""
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise OSError(f"无法读取 {path}")
    return img.astype(np.int32)
