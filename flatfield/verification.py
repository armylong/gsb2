"""Ground-truth handling and objective checking of a correction result."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .core import (
    FULL_SCALE,
    CorrectionResult,
    ReferenceModel,
    RegionSummary,
    region_summary,
)


class TruthError(Exception):
    pass


@dataclass
class GroundTruth:
    bias: np.ndarray
    flat_norm: np.ndarray
    sample_ideal: np.ndarray
    texture: np.ndarray
    illumination: np.ndarray
    true_defects: np.ndarray
    true_large_area: np.ndarray
    background_level: float = 0.08
    size: tuple[int, int] = (0, 0)
    seed: int = 0
    meta: dict[str, Any] = field(default_factory=dict)
    source: str = ""

    @property
    def shape(self) -> tuple[int, int]:
        return self.true_defects.shape  # type: ignore[return-value]

    @property
    def background_mask(self) -> np.ndarray:
        return self.texture <= self.background_level * 1.25

    @property
    def texture_mask(self) -> np.ndarray:
        return self.texture > self.background_level * 1.25

    @property
    def valid_truth(self) -> np.ndarray:
        return ~self.true_defects


def ground_truth_from_set(dataset) -> GroundTruth:  # SyntheticSet, avoid circular import
    return GroundTruth(
        bias=np.array(dataset.bias, np.float32),
        flat_norm=np.array(dataset.flat_norm, np.float32),
        sample_ideal=np.array(dataset.sample_ideal, np.float32),
        texture=np.array(dataset.texture, np.float32),
        illumination=np.array(dataset.illumination, np.float32),
        true_defects=np.array(dataset.true_defects, bool),
        true_large_area=np.array(dataset.true_large_area, bool),
        background_level=float(dataset.background_level),
        size=tuple(int(v) for v in dataset.size),
        seed=int(dataset.seed),
        meta=dataset.meta.to_dict(),
        source="generated",
    )


def load_ground_truth(path: str | Path) -> GroundTruth:
    p = Path(path)
    if p.is_dir():
        p = p / "ground_truth.npz"
    if not p.exists():
        raise TruthError(f"{p}: 找不到真值文件")
    try:
        data = np.load(p, allow_pickle=False)
    except (OSError, ValueError) as exc:
        raise TruthError(f"{p.name}: 无法读取真值 ({exc})") from exc
    required = ("bias", "flat_norm", "sample_ideal", "texture", "illumination",
                "true_defects", "true_large_area")
    with data:
        missing = [k for k in required if k not in data.files]
        if missing:
            raise TruthError(f"{p.name}: 缺少字段 {', '.join(missing)}")
        meta: dict[str, Any] = {}
        if "meta" in data.files:
            try:
                meta = json.loads(str(data["meta"].item()))
            except (TypeError, ValueError):
                meta = {}
        size = tuple(int(v) for v in data["size"]) if "size" in data.files else (
            int(data["bias"].shape[0]), int(data["bias"].shape[1]))
        return GroundTruth(
            bias=np.asarray(data["bias"], np.float32),
            flat_norm=np.asarray(data["flat_norm"], np.float32),
            sample_ideal=np.asarray(data["sample_ideal"], np.float32),
            texture=np.asarray(data["texture"], np.float32),
            illumination=np.asarray(data["illumination"], np.float32),
            true_defects=np.asarray(data["true_defects"], bool),
            true_large_area=np.asarray(data["true_large_area"], bool),
            background_level=float(data["background_level"]) if "background_level" in data.files else 0.08,
            size=size,
            seed=int(data["seed"]) if "seed" in data.files else 0,
            meta=meta,
            source=str(p),
        )


def find_adjacent_truth(path: str | Path) -> GroundTruth | None:
    p = Path(path)
    if p.is_dir():
        candidate = p / "ground_truth.npz"
    else:
        candidate = p.parent / "ground_truth.npz"
    if candidate.exists():
        try:
            return load_ground_truth(candidate)
        except TruthError:
            return None
    return None


# --------------------------------------------------------------------------- #
# Metrics
# --------------------------------------------------------------------------- #

@dataclass
class VariantMetrics:
    label: str
    background: RegionSummary | None
    texture_corr: float
    texture_ratio_median: float
    texture_contrast_ratio: float
    valid_fraction: float


@dataclass
class VerificationReport:
    variants: list[VariantMetrics]
    truth: VariantMetrics
    defect_recall: float
    defect_precision: float
    defect_iou: float
    large_region_iou: float
    mask_agreement: float
    detected_large: int
    truth_large: int
    notes: list[str] = field(default_factory=list)

    def variant(self, label: str) -> VariantMetrics | None:
        for item in self.variants:
            if item.label == label:
                return item
        return None

    def to_dict(self) -> dict[str, Any]:
        def pack(v: VariantMetrics) -> dict[str, Any]:
            bg = v.background
            return {
                "label": v.label,
                "background": None if bg is None else {
                    "plane_std_pct": bg.plane_std_pct,
                    "p1p99_pct": bg.p1p99_pct,
                    "center_mean": bg.center_mean,
                    "edge_mean": bg.edge_mean,
                    "edge_center_ratio": bg.edge_center_ratio,
                    "valid_fraction": bg.valid_fraction,
                },
                "texture_corr": v.texture_corr,
                "texture_ratio_median": v.texture_ratio_median,
                "texture_contrast_ratio": v.texture_contrast_ratio,
                "valid_fraction": v.valid_fraction,
            }

        return {
            "variants": [pack(v) for v in self.variants],
            "truth": pack(self.truth),
            "defect_recall": self.defect_recall,
            "defect_precision": self.defect_precision,
            "defect_iou": self.defect_iou,
            "large_region_iou": self.large_region_iou,
            "mask_agreement": self.mask_agreement,
            "detected_large": self.detected_large,
            "truth_large": self.truth_large,
            "notes": self.notes,
        }


def _texture_stats(data: np.ndarray, valid: np.ndarray, truth: GroundTruth
                   ) -> tuple[float, float, float]:
    mask = valid & truth.texture_mask & truth.valid_truth
    if np.count_nonzero(mask) < 10:
        return float("nan"), float("nan"), float("nan")
    values = data[mask].astype(np.float64)
    ideal = truth.sample_ideal[mask].astype(np.float64)
    finite = np.isfinite(values)
    if np.count_nonzero(finite) < 10:
        return float("nan"), float("nan"), float("nan")
    values, ideal = values[finite], ideal[finite]
    corr = float(np.corrcoef(values, ideal)[0, 1]) if values.std() > 0 and ideal.std() > 0 else float("nan")
    ratio = float(np.median(values / np.maximum(ideal, 1e-6))) if ideal.size else float("nan")
    ideal_std = float(ideal.std())
    contrast = float(values.std() / ideal_std) if ideal_std > 0 else float("nan")
    return corr, ratio, contrast


def _variant(label: str, data: np.ndarray, valid: np.ndarray,
             truth: GroundTruth) -> VariantMetrics:
    bg_mask = valid & truth.background_mask & truth.valid_truth
    bg = region_summary(data, bg_mask)
    corr, ratio, contrast = _texture_stats(data, valid, truth)
    return VariantMetrics(
        label=label,
        background=bg,
        texture_corr=corr,
        texture_ratio_median=ratio,
        texture_contrast_ratio=contrast,
        valid_fraction=float(np.count_nonzero(valid)) / valid.size,
    )


def evaluate(
    sample_array: np.ndarray,
    model: ReferenceModel,
    correction: CorrectionResult,
    truth: GroundTruth,
    sat_value: int = FULL_SCALE,
) -> VerificationReport:
    if truth.shape != sample_array.shape:
        raise TruthError(
            f"真值尺寸 {truth.shape[1]}×{truth.shape[0]} 与样品 "
            f"{sample_array.shape[1]}×{sample_array.shape[0]} 不一致")
    sample = np.asarray(sample_array, np.float32)
    eval_valid = truth.valid_truth & model.valid_mask & (sample < sat_value)

    raw = sample
    dark_only = sample - model.dark_mean
    full = correction.corrected
    full_valid = eval_valid & np.isfinite(full)
    raw_valid = eval_valid
    dark_valid = eval_valid

    variants = [
        _variant("原始样品", raw, raw_valid, truth),
        _variant("仅暗场", dark_only, dark_valid, truth),
        _variant("暗场+亮场", np.nan_to_num(full, nan=0.0), full_valid, truth),
    ]
    truth_metrics = _variant("真值理想结果", truth.sample_ideal,
                             truth.valid_truth & model.valid_mask, truth)

    detected = model.defects.invalid
    actual = truth.true_defects
    tp = int(np.count_nonzero(detected & actual))
    fp = int(np.count_nonzero(detected & ~actual))
    fn = int(np.count_nonzero(~detected & actual))
    recall = tp / (tp + fn) if tp + fn else 1.0
    precision = tp / (tp + fp) if tp + fp else 1.0
    union = tp + fp + fn
    iou = tp / union if union else 1.0

    detected_large = np.zeros(actual.shape, bool)
    for comp in model.defects.large_components:
        r0, c0, r1, c1 = comp.bbox
        detected_large[r0:r1 + 1, c0:c1 + 1] |= (
            model.defects.labels[r0:r1 + 1, c0:c1 + 1] == comp.id)
    large_tp = int(np.count_nonzero(detected_large & truth.true_large_area))
    large_union = int(np.count_nonzero(detected_large | truth.true_large_area))
    large_iou = large_tp / large_union if large_union else 1.0

    mask_agreement = float(np.count_nonzero(
        correction.valid_mask == (truth.valid_truth & ~model.defects.invalid))) / correction.valid_mask.size

    notes = []
    bg_variant = variants[2].background
    if bg_variant and np.isfinite(bg_variant.plane_std_pct):
        notes.append(f"校正后背景平面残差 {bg_variant.plane_std_pct:.2f}% (真值理想 "
                     f"{truth_metrics.background.plane_std_pct:.2f}%)。")
    if variants[2].texture_corr == variants[2].texture_corr:
        notes.append(f"纹理相关系数 {variants[2].texture_corr:.5f}，幅度比 "
                     f"{variants[2].texture_ratio_median:.4f}。")
    if recall < 0.95:
        notes.append(f"缺陷召回率 {recall:.1%}，可能有未标记缺陷。")
    if precision < 0.95:
        notes.append(f"缺陷精确率 {precision:.1%}，可能误标了正常像素。")
    if large_iou < 0.9 and truth.true_large_area.any():
        notes.append(f"大面积无效区域与真值重叠率仅 {large_iou:.1%}。")

    return VerificationReport(
        variants=variants,
        truth=truth_metrics,
        defect_recall=float(recall),
        defect_precision=float(precision),
        defect_iou=float(iou),
        large_region_iou=float(large_iou),
        mask_agreement=mask_agreement,
        detected_large=len(model.defects.large_components),
        truth_large=len(_components_of(truth.true_large_area)),
        notes=notes,
    )


def _components_of(mask: np.ndarray) -> list[int]:
    from .core import connected_components

    _, stats = connected_components(mask)
    return [1] * len(stats)


@dataclass
class VariantImage:
    label: str
    data: np.ndarray
    valid: np.ndarray
    note: str = ""


def variant_images(sample_array: np.ndarray, model: ReferenceModel,
                   correction: CorrectionResult) -> list[VariantImage]:
    """Images used for side-by-side checking, all at the same scale."""
    sample = np.asarray(sample_array, np.float32)
    valid = model.valid_mask & (sample < model.config.sat_value)
    full = np.where(valid, correction.corrected, np.nan)
    return [
        VariantImage("原始样品", sample, valid, "含暗角、偏置与饱和点"),
        VariantImage("仅暗场", sample - model.dark_mean, valid, "去掉固定底值, 仍有亮度起伏"),
        VariantImage("暗场+亮场", full, valid, "目标: 背景平坦且纹理保留"),
    ]
