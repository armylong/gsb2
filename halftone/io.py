"""图像读取、结果导出与回读校验。

导出物:
- 原尺寸、只含黑白像素(0/255)的单通道 PNG，不带任何界面网格或标注；
- 同名 .json 参数记录(参数、来源、选区统计、尺寸与 sha256)。
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

MAX_EDGE = 1200
_SUFFIXES = {".png", ".jpg", ".jpeg"}


class ImageLoadError(Exception):
    """文件无法读取或不符合约束，消息可直接弹窗提示。"""


# ---------------------------------------------------------------------------
# 读取
# ---------------------------------------------------------------------------
def load_image(path: str) -> np.ndarray:
    """读取不透明 PNG/JPEG，返回 3 通道 BGR uint8。

    约束: 后缀白名单、文件可读、无透明通道、最长边 <= 1200。
    任何不满足都抛 ImageLoadError，由界面以普通提示展示。
    """
    if not isinstance(path, str) or not path:
        raise ImageLoadError("未提供文件路径")
    suffix = os.path.splitext(path)[1].lower()
    if suffix not in _SUFFIXES:
        raise ImageLoadError("仅支持 PNG 或 JPEG 文件")
    if not os.path.isfile(path):
        raise ImageLoadError(f"文件不存在或无法读取：{path}")

    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ImageLoadError(f"文件无法读取(可能已损坏)：{os.path.basename(path)}")
    if img.dtype != np.uint8:
        raise ImageLoadError("仅支持 8 位图像")

    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    elif img.ndim == 3:
        if img.shape[2] == 4:
            alpha = img[:, :, 3]
            if int(alpha.min()) < 255:
                raise ImageLoadError("不支持带透明通道的图像，请提供不透明 PNG/JPEG")
            img = img[:, :, :3]
        elif img.shape[2] == 1:
            img = cv2.cvtColor(img[:, :, 0], cv2.COLOR_GRAY2BGR)
        elif img.shape[2] != 3:
            raise ImageLoadError(f"不支持的通道数：{img.shape[2]}")
    else:
        raise ImageLoadError("不支持的图像维度")

    h, w = img.shape[:2]
    if max(h, w) > MAX_EDGE:
        raise ImageLoadError(
            f"图像最长边为 {max(h, w)}px，超过 {MAX_EDGE}px 限制，请缩小后再打开"
        )
    return np.ascontiguousarray(img)


# ---------------------------------------------------------------------------
# 导出
# ---------------------------------------------------------------------------
def _sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def export_result(
    png_path: str,
    binary: np.ndarray,
    params: dict[str, Any],
    source_name: str = "",
    stats: list[dict[str, Any]] | None = None,
) -> tuple[str, str]:
    """导出二值 PNG 与参数记录 JSON，返回 (png 路径, json 路径)。"""
    if binary.ndim != 2 or binary.dtype != np.uint8:
        raise ValueError("导出对象必须是单通道 uint8 二值图")
    unique = set(np.unique(binary).tolist())
    if not unique.issubset({0, 255}):
        raise ValueError("导出对象含有非黑白像素，拒绝导出")

    directory = os.path.dirname(os.path.abspath(png_path))
    os.makedirs(directory, exist_ok=True)
    if not cv2.imwrite(png_path, binary):
        raise ImageLoadError(f"PNG 写入失败：{png_path}")

    digest = _sha256_of(png_path)
    record = {
        "format": "halftone-preview/1",
        "source": source_name,
        "image": {
            "width": int(binary.shape[1]),
            "height": int(binary.shape[0]),
            "channels": 1,
            "unique_values": sorted(unique),
            "black_fraction": float(
                np.count_nonzero(binary == 0) / binary.size
            ),
            "sha256": digest,
        },
        "params": dict(params),
        "selection_stats": list(stats or []),
    }
    json_path = os.path.splitext(png_path)[0] + ".json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)
    return png_path, json_path


# ---------------------------------------------------------------------------
# 回读校验
# ---------------------------------------------------------------------------
@dataclass
class ExportCheck:
    ok: bool
    width: int
    height: int
    unique_values: list[int]
    black_fraction: float
    sha256_match: bool | None = None
    size_match: bool | None = None
    coverage_match: bool | None = None
    messages: list[str] = field(default_factory=list)

    def summary(self) -> str:
        head = "回读校验通过" if self.ok else "回读校验发现问题"
        lines = [
            head,
            f"尺寸: {self.width} x {self.height}",
            f"像素取值: {self.unique_values} (只允许 [0, 255])",
            f"全图黑像素占比: {self.black_fraction:.4f}",
        ]
        if self.sha256_match is not None:
            lines.append(f"sha256 与记录一致: {'是' if self.sha256_match else '否'}")
            lines.append(f"尺寸与记录一致: {'是' if self.size_match else '否'}")
            lines.append(
                f"选区覆盖率与记录一致: {'是' if self.coverage_match else '否'}"
            )
        lines.extend(f"- {m}" for m in self.messages)
        return "\n".join(lines)


def verify_export(png_path: str, record_path: str | None = None) -> ExportCheck:
    """回读 PNG 并检查尺寸、黑白值；给了记录则再核对尺寸/摘要/选区覆盖率。"""
    img = cv2.imread(png_path, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ImageLoadError(f"回读失败，无法打开：{png_path}")

    messages: list[str] = []
    ok = True
    if img.ndim != 2:
        ok = False
        messages.append("回读图像不是单通道灰度 PNG")
    unique = sorted(np.unique(img).tolist())
    if not set(unique).issubset({0, 255}):
        ok = False
        messages.append(f"发现非黑白像素: {unique}")
    h, w = img.shape[:2]
    frac = float(np.count_nonzero(img == 0) / img.size)

    check = ExportCheck(
        ok=ok, width=w, height=h, unique_values=unique, black_fraction=frac
    )
    if record_path is None:
        check.messages = messages
        return check

    with open(record_path, "r", encoding="utf-8") as f:
        record = json.load(f)

    rec_img = record["image"]
    check.size_match = (
        rec_img["width"] == w and rec_img["height"] == h
    )
    check.sha256_match = _sha256_of(png_path) == rec_img["sha256"]
    if not check.size_match:
        ok = False
        messages.append(
            f"尺寸不一致: 记录 {rec_img['width']}x{rec_img['height']}，回读 {w}x{h}"
        )
    if not check.sha256_match:
        ok = False
        messages.append("sha256 不一致，导出文件可能被改动")
    if abs(rec_img["black_fraction"] - frac) > 1e-12:
        ok = False
        messages.append("全图黑像素占比与记录不一致")

    # 选区覆盖率：用回读图像重新数，不直接相信记录里的数字
    coverage_ok = True
    for item in record.get("selection_stats", []):
        rx, ry, rw, rh = item["rect"]
        roi = img[ry : ry + rh, rx : rx + rw]
        if roi.size == 0:
            coverage_ok = False
            messages.append(f"记录中的选区 {item['rect']} 回读后为空")
            continue
        got = float(np.count_nonzero(roi == 0) / roi.size)
        if abs(got - item["measured_black_fraction"]) > 1e-12:
            coverage_ok = False
            messages.append(
                f"选区 {item['rect']} 覆盖率不一致: 记录 "
                f"{item['measured_black_fraction']:.4f}，回读 {got:.4f}"
            )
    check.coverage_match = coverage_ok
    if not coverage_ok:
        ok = False

    check.ok = ok
    check.messages = messages
    return check
