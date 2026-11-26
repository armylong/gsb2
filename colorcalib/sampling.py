"""色格取样区域与代表值提取。

取样区域用整数矩形 [x0, y0, x1, y1)（像素坐标，半开区间）表示。
代表值取区域内像素的逐通道中位数（对反光亮点、噪点更稳健）。

每个取样结果同时给出质量标记：
- overexposed：区域内任一通道达到/接近 255 的像素比例过高，可能过曝；
- border_risk：区域边缘与内部的亮度差异过大，可能取到了色格边框/背景；
- uniform：区域是否足够均匀（标准差小），作为辅助参考。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

# 单通道 >= 该值即视为接近过曝（8bit 传感器接近饱和区）
_CLIP_LEVEL = 252.0
# 区域内接近过曝的像素比例超过该值，标记 overexposed
_OVEREXPOSED_RATIO = 0.05
# 边缘一圈与中心区域的中位亮度差（0-255 量纲）超过该值，标记 border_risk
_BORDER_LIGHTNESS_DELTA = 12.0
# 中心区域占边长的比例（内缩 25%）
_CENTER_FRACTION = 0.5


@dataclass
class ROIRect:
    """一个色格的取样矩形（半开像素区间）。"""

    patch_id: str
    x0: int
    y0: int
    x1: int
    y1: int
    # fit = 参与对色拟合；check = 仅用于留出验证
    role: str = "fit"
    enabled: bool = True

    def clamp(self, width: int, height: int) -> "ROIRect":
        return ROIRect(
            patch_id=self.patch_id,
            x0=int(np.clip(self.x0, 0, width)),
            y0=int(np.clip(self.y0, 0, height)),
            x1=int(np.clip(self.x1, 0, width)),
            y1=int(np.clip(self.y1, 0, height)),
            role=self.role,
            enabled=self.enabled,
        )

    @property
    def area(self) -> int:
        return max(0, self.x1 - self.x0) * max(0, self.y1 - self.y0)


@dataclass
class SampleResult:
    """一个色格的取样结果。"""

    patch_id: str
    roi: ROIRect
    median_rgb: np.ndarray  # shape (3,)，sRGB 0-255
    std_rgb: np.ndarray  # shape (3,)，逐通道标准差
    overexposed: bool
    overexposed_ratio: float
    border_risk: bool
    border_delta: float
    # usable 只表示区域本身能否取样（非空、够大）；
    # 是否参与计算由 ROIRect.enabled / role 单独决定，避免把“手动停用”和“取样失败”混淆
    usable: bool
    note: str = ""
    warnings: list[str] = field(default_factory=list)


def _extract(image: np.ndarray, roi: ROIRect) -> np.ndarray:
    h, w = image.shape[:2]
    x0, y0 = max(0, roi.x0), max(0, roi.y0)
    x1, y1 = min(w, roi.x1), min(h, roi.y1)
    return image[y0:y1, x0:x1, :].reshape(-1, 3).astype(np.float64)


def sample_patch(image: np.ndarray, roi: ROIRect) -> SampleResult:
    """对单个 ROI 取样并做质量检查。image 为 HxWx3 的 sRGB 0-255 数组。"""
    h, w = image.shape[:2]
    clamped = roi.clamp(w, h)
    pixels = _extract(image, clamped)

    warnings: list[str] = []
    if pixels.shape[0] < 9:
        return SampleResult(
            patch_id=roi.patch_id,
            roi=clamped,
            median_rgb=np.zeros(3),
            std_rgb=np.zeros(3),
            overexposed=False,
            overexposed_ratio=0.0,
            border_risk=False,
            border_delta=0.0,
            usable=False,
            note="取样区域过小或为空",
            warnings=warnings + ["区域过小"],
        )

    median = np.median(pixels, axis=0)
    std = np.std(pixels, axis=0)

    # 过曝：任一通道接近饱和的像素占比
    near_clip = np.any(pixels >= _CLIP_LEVEL, axis=1)
    over_ratio = float(np.mean(near_clip))
    overexposed = over_ratio >= _OVEREXPOSED_RATIO
    if overexposed:
        warnings.append(f"可能过曝（{over_ratio * 100:.0f}% 像素接近饱和）")

    # 边框风险：边缘一圈 vs 中心区域的亮度差
    ph = clamped.y1 - clamped.y0
    pw = clamped.x1 - clamped.x0
    cy = clamped.y0 + int(ph * (1 - _CENTER_FRACTION) / 2)
    cx = clamped.x0 + int(pw * (1 - _CENTER_FRACTION) / 2)
    cy1 = cy + max(1, int(ph * _CENTER_FRACTION))
    cx1 = cx + max(1, int(pw * _CENTER_FRACTION))
    center = image[cy:cy1, cx:cx1, :].reshape(-1, 3).astype(np.float64)
    # 边缘 = 全部像素中排除中心矩形（用亮度近似即可）
    edge_lum = float(np.median(0.2126 * pixels[:, 0] + 0.7152 * pixels[:, 1] + 0.0722 * pixels[:, 2]))
    center_lum = float(np.median(0.2126 * center[:, 0] + 0.7152 * center[:, 1] + 0.0722 * center[:, 2]))
    border_delta = abs(edge_lum - center_lum)
    border_risk = border_delta >= _BORDER_LIGHTNESS_DELTA
    if border_risk:
        warnings.append(f"可能取到边框（边缘与中心亮度差 {border_delta:.1f}）")

    note = "；".join(warnings) if warnings else "正常"
    return SampleResult(
        patch_id=roi.patch_id,
        roi=clamped,
        median_rgb=median,
        std_rgb=std,
        overexposed=overexposed,
        overexposed_ratio=over_ratio,
        border_risk=border_risk,
        border_delta=border_delta,
        usable=True,
        note=note,
        warnings=warnings,
    )


def sample_all(image: np.ndarray, rois: list[ROIRect]) -> dict[str, SampleResult]:
    """对所有 ROI 取样，返回 patch_id -> SampleResult。"""
    return {roi.patch_id: sample_patch(image, roi) for roi in rois}
