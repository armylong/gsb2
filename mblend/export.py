"""Export results and masks, plus a human-readable parameter record.

The exported PNG is produced by exactly the same pipeline as the on-screen
preview: the blend result is linear light, converted to sRGB once at the end.
Which pyramid level is currently being inspected has no influence on the
exported pixels.

The mask is written as an 8-bit grayscale PNG at the original resolution.
Mask values are *data*, not colour, so they are scaled linearly
(1.0 -> 255, 0.0 -> 0) without an sRGB transfer.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

from .color import linear_to_rgb8
from .engine import MODE_NAIVE, MODE_PYRAMID
from .pyramid import max_levels


class ExportError(RuntimeError):
    pass


@dataclass
class ExportInfo:
    """Record of what was written and with which parameters."""

    output_png: str
    mask_png: str
    record_json: str
    width: int
    height: int
    mode: str
    levels: int
    mask_mean: float
    mask_min: float
    mask_max: float
    color_pipeline: str
    written_at: str

    def as_dict(self) -> dict:
        return asdict(self)


def _write_png(path: Path, image: np.ndarray) -> None:
    if image.dtype != np.uint8:
        raise ExportError(f"unsupported dtype for PNG: {image.dtype}")
    if image.ndim == 3:
        if image.shape[2] != 3:
            raise ExportError("RGB export expects three channels")
        data = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
    elif image.ndim == 2:
        data = image
    else:
        raise ExportError(f"unsupported image shape for PNG: {image.shape}")
    ok, encoded = cv2.imencode(".png", data)
    if not ok:
        raise ExportError(f"无法编码 PNG: {path.name}")
    try:
        encoded.tofile(str(path))
    except OSError as exc:  # pragma: no cover - filesystem dependent
        raise ExportError(f"无法写入文件 {path}: {exc}") from exc


def mask_to_gray8(mask: np.ndarray) -> np.ndarray:
    """Linear 8-bit representation of the mask (1 -> 255, 0 -> 0)."""
    return np.clip(np.rint(np.clip(mask, 0.0, 1.0) * 255.0), 0, 255).astype(np.uint8)


def export_result(
    directory: str | Path,
    stem: str,
    result_linear: np.ndarray,
    mask: np.ndarray,
    *,
    mode: str,
    levels: int,
) -> ExportInfo:
    """Write result PNG, mask PNG and a JSON parameter record."""
    directory = Path(directory)
    if not directory.is_dir():
        raise ExportError(f"导出目录不存在: {directory}")
    stem = stem.strip() or "blend"
    if any(sep in stem for sep in ("/", "\\")):
        raise ExportError("输出文件名不能包含路径分隔符")

    result_linear = np.asarray(result_linear)
    mask = np.asarray(mask, dtype=np.float32)
    if result_linear.ndim != 3 or result_linear.shape[2] != 3:
        raise ExportError("混合结果必须是 H×W×3")
    height, width = result_linear.shape[:2]
    if mask.shape != (height, width):
        raise ExportError("掩码尺寸与结果不一致")
    if mode not in (MODE_NAIVE, MODE_PYRAMID):
        raise ExportError(f"未知混合模式: {mode}")
    limit = max_levels(height, width)
    if mode == MODE_PYRAMID and not 2 <= levels <= min(6, limit):
        raise ExportError(f"层数 {levels} 超出 {width}×{height} 支持范围")

    output_png = directory / f"{stem}.png"
    mask_png = directory / f"{stem}_mask.png"
    record_json = directory / f"{stem}.json"

    rgb8 = linear_to_rgb8(result_linear)
    _write_png(output_png, rgb8)
    _write_png(mask_png, mask_to_gray8(mask))

    info = ExportInfo(
        output_png=str(output_png),
        mask_png=str(mask_png),
        record_json=str(record_json),
        width=width,
        height=height,
        mode=mode,
        levels=levels if mode == MODE_PYRAMID else 0,
        mask_mean=float(mask.mean()),
        mask_min=float(mask.min()),
        mask_max=float(mask.max()),
        color_pipeline="sRGB文件 -> 线性光混合 -> sRGB PNG",
        written_at=datetime.now().isoformat(timespec="seconds"),
    )
    try:
        record_json.write_text(
            json.dumps(info.as_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except OSError as exc:  # pragma: no cover - filesystem dependent
        raise ExportError(f"无法写入记录文件: {exc}") from exc
    return info


def read_png(path: str | Path) -> np.ndarray:
    """Read a PNG back as uint8 RGB or 2-D grayscale (used by tests/users)."""
    data = np.fromfile(str(path), dtype=np.uint8)
    decoded = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if decoded is None:
        raise ExportError(f"无法读取 {path}")
    if decoded.ndim == 3 and decoded.shape[2] == 3:
        return cv2.cvtColor(decoded, cv2.COLOR_BGR2RGB)
    return decoded
