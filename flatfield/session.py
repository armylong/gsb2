"""Session state: frames, conditions, reference model, correction cache."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Literal

import numpy as np

from .core import (
    FULL_SCALE,
    Conditions,
    CorrectionResult,
    DefectConfig,
    Frame,
    GroupStats,
    Issue,
    PatchPolicy,
    ReferenceModel,
    apply_patch_policy,
    build_reference,
    correct,
    frame_stats,
    group_stats,
    flat_profile_reference,
    make_profiles,
    region_summary,
    validate_set,
)
from .verification import GroundTruth, VerificationReport, evaluate, find_adjacent_truth, ground_truth_from_set

ViewKey = Literal[
    "corrected", "original", "dark_only", "dark_mean", "flat_norm", "light_mean",
    "mask",
]


@dataclass
class ViewData:
    key: str
    title: str
    array: np.ndarray            # float32 preview data (NaN = invalid)
    valid: np.ndarray            # bool, usable pixels
    unit: str = "ADU"
    fixed_display: tuple[float, float] | None = None
    note: str = ""


@dataclass
class ImportResult:
    accepted: list[Frame] = field(default_factory=list)
    rejected: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return bool(self.accepted)


class Session:
    """Everything the window shows, with caches keyed by its inputs."""

    def __init__(self) -> None:
        self.darks: list[Frame] = []
        self.lights: list[Frame] = []
        self.sample: Frame | None = None
        self.truth: GroundTruth | None = None
        self.conditions = Conditions(dark_exposure_ms=30.0, light_exposure_ms=30.0,
                                     sample_exposure_ms=30.0, gain_db=0.0)
        self.config = DefectConfig()
        self.apply_dark = True
        self.apply_light = True
        self.patch_policy: PatchPolicy = "none"
        self.selected_patches: set[int] = set()

        self.model: ReferenceModel | None = None
        self.correction: CorrectionResult | None = None
        self.issues: list[Issue] = []
        self._model_key: tuple | None = None
        self._correction_key: tuple | None = None
        self._view_cache: dict[tuple, ViewData] = {}

    # ------------------------------------------------------------------ #
    # Frame management
    # ------------------------------------------------------------------ #
    def add_frames(self, group: str, frames: Iterable[Frame]) -> None:
        target = {"dark": self.darks, "light": self.lights}.get(group)
        if target is None:
            raise ValueError(f"unknown group {group!r}")
        def key(frame: Frame):
            return frame.path if frame.path else (frame.name, id(frame.array))

        existing = {key(f) for f in target}
        for frame in frames:
            if key(frame) in existing:
                continue
            target.append(frame)
            existing.add(key(frame))
        self._invalidate()

    def set_sample(self, frame: Frame) -> None:
        self.sample = frame
        self._invalidate()
        if self.truth is not None and self.truth.shape != frame.shape:
            self.truth = None

    def remove_frame(self, group: str, index: int) -> None:
        target = {"dark": self.darks, "light": self.lights}.get(group)
        if target is None or not (0 <= index < len(target)):
            return
        target.pop(index)
        self._invalidate()

    def clear(self, group: str | None = None) -> None:
        if group in (None, "dark"):
            self.darks.clear()
        if group in (None, "light"):
            self.lights.clear()
        if group in (None, "sample"):
            self.sample = None
            self.truth = None
        self._invalidate()

    def attach_truth_adjacent(self, path: str) -> bool:
        truth = find_adjacent_truth(path)
        if truth is None:
            return False
        self.truth = truth
        return True

    def attach_truth_generated(self, dataset) -> None:
        self.truth = ground_truth_from_set(dataset)

    def _invalidate(self) -> None:
        self._model_key = None
        self._correction_key = None
        self.model = None
        self.correction = None
        self._view_cache.clear()

    # ------------------------------------------------------------------ #
    # Validation & stats
    # ------------------------------------------------------------------ #
    def validate(self) -> list[Issue]:
        self.issues = validate_set(self.darks, self.lights, self.sample, self.conditions)
        return self.issues

    @property
    def ready_for_reference(self) -> bool:
        return bool(self.darks and self.lights)

    @property
    def can_correct(self) -> bool:
        model = self.ensure_model()
        return model is not None and self.sample is not None

    def dark_stats(self) -> GroupStats:
        return group_stats(self.darks, "暗场", self.config.sat_value)

    def light_stats(self) -> GroupStats:
        return group_stats(self.lights, "亮场", self.config.sat_value)

    def sample_stats(self):
        return frame_stats(self.sample, self.config.sat_value) if self.sample else None

    # ------------------------------------------------------------------ #
    # Reference model
    # ------------------------------------------------------------------ #
    def _reference_signature(self) -> tuple:
        return (
            tuple((f.path, f.shape, id(f.array)) for f in self.darks),
            tuple((f.path, f.shape, id(f.array)) for f in self.lights),
            self.config.low_frac, self.config.sat_value,
            self.config.sat_persist_frac, self.config.unstable_k,
            self.config.unstable_min_rel, self.config.temporal_k,
            self.config.spatial_radius, self.config.large_region_px,
            self.config.patch_radius,
        )

    def ensure_model(self) -> ReferenceModel | None:
        if not self.ready_for_reference:
            self.model = None
            self.correction = None
            return None
        # dimension check: refuse to build on mismatched sets
        shapes = {f.shape for f in self.darks} | {f.shape for f in self.lights}
        if len(shapes) > 1 or (self.sample is not None and self.sample.shape not in shapes):
            self.model = None
            self.correction = None
            return None
        key = self._reference_signature() + (self.patch_policy, tuple(sorted(self.selected_patches)))
        if self.model is not None and self._model_key == key:
            return self.model
        try:
            base = build_reference(self.darks, self.lights, self.config,
                                   patch_policy="none")
        except ValueError:
            self.model = None
            self.correction = None
            return None
        self.model = apply_patch_policy(base, self.patch_policy, self.selected_patches)
        self.model.notes = base.notes
        self._model_key = key
        self._correction_key = None
        return self.model

    # ------------------------------------------------------------------ #
    # Correction
    # ------------------------------------------------------------------ #
    def ensure_correction(self) -> CorrectionResult | None:
        model = self.ensure_model()
        if model is None or self.sample is None:
            return None
        key = (self._model_key, self.apply_dark, self.apply_light, self.sample.path,
               id(self.sample.array))
        if self.correction is not None and self._correction_key == key:
            return self.correction
        self.correction = correct(self.sample, model,
                                  apply_dark=self.apply_dark,
                                  apply_light=self.apply_light)
        self._correction_key = key
        return self.correction

    # ------------------------------------------------------------------ #
    # Views
    # ------------------------------------------------------------------ #
    def view(self, key: ViewKey) -> ViewData | None:
        self.ensure_model()
        if key in ("corrected", "dark_only"):
            self.ensure_correction()
        cache_key = (key, self._model_key, self._correction_key,
                     self.apply_dark, self.apply_light)
        cached = self._view_cache.get(cache_key)
        if cached is not None:
            return cached
        view = self._build_view(key)
        if view is not None:
            if len(self._view_cache) > 24:
                self._view_cache.clear()
            self._view_cache[cache_key] = view
        return view

    def _build_view(self, key: ViewKey) -> ViewData | None:
        model = self.ensure_model()
        correction = self.ensure_correction()
        if key == "original":
            if self.sample is None:
                return None
            arr = self.sample.array.astype(np.float32)
            valid = model.valid_mask.copy() if model is not None else np.ones(arr.shape, bool)
            if model is not None:
                valid &= arr < self.config.sat_value
            return ViewData("original", "原样品", arr, valid,
                            note="原始数据保持不变; 饱和与缺陷像素不计入有效区域")
        if key == "dark_only":
            if model is None or self.sample is None:
                return None
            arr = (self.sample.array.astype(np.float32) - model.dark_mean)
            valid = model.valid_mask & (self.sample.array < self.config.sat_value)
            arr = np.where(valid, arr, np.nan)
            return ViewData("dark_only", "仅暗场修正", arr, valid,
                            note="去掉固定底值后, 仍能看到亮场带来的亮度起伏")
        if key == "corrected":
            if correction is None:
                return None
            arr = correction.corrected
            return ViewData("corrected", correction.source, arr, correction.valid_mask,
                            note="显示范围仅影响预览, 导出数值不受影响")
        if model is None:
            return None
        if key == "dark_mean":
            return ViewData("dark_mean", "暗场均值 (固定底值)", model.dark_mean,
                            np.ones(model.shape, bool),
                            note="由暗场平均得到, 用于扣除固定偏置")
        if key == "light_mean":
            return ViewData("light_mean", "亮场均值", model.light_mean,
                            np.ones(model.shape, bool),
                            note="亮场均值 = 偏置 + 亮场响应")
        if key == "mask":
            mask = model.valid_mask
            if correction is not None:
                mask = correction.valid_mask
            arr = np.where(mask, np.float32(FULL_SCALE), np.float32(0))
            return ViewData("mask", "有效区域掩膜", arr, np.ones_like(mask),
                            fixed_display=(0.0, float(FULL_SCALE)),
                            note="白色 = 参与校正/可用于分析; 黑色 = 缺陷或样品饱和; "
                                 "导出为 0/65535 的 16 位 PNG")
        if key == "flat_norm":
            arr = model.flat_norm * model.flat_scale
            arr = np.where(model.valid_mask, arr, np.nan)
            return ViewData("flat_norm", "归一化亮场", arr, model.valid_mask,
                            note=f"归一化基准 {model.flat_scale:.1f} ADU (中位数); "
                                 f"缺陷像素已按当前策略处理")
        raise ValueError(f"unknown view {key!r}")

    def profiles(self, key: ViewKey, with_reference: bool = False):
        data = self.view(key)
        if data is None:
            return [], []
        profiles = make_profiles(data.array, data.valid)
        if not with_reference or self.model is None:
            return profiles, []
        values = data.array[data.valid]
        if values.size == 0:
            return profiles, []
        level = float(np.median(values))
        return profiles, flat_profile_reference(self.model, level)

    def region_summary(self, key: ViewKey):
        data = self.view(key)
        if data is None:
            return None
        return region_summary(data.array, data.valid)

    def flatness(self, key: ViewKey) -> dict[str, float] | None:
        """Flatness numbers for the current view.

        For reference views (no sample texture) the plane residual is a direct
        flatness measure.  For sample views it is only meaningful when a ground
        truth exists, so the exclusion mask is applied then.
        """
        data = self.view(key)
        if data is None:
            return None
        valid = data.valid
        reference_view = key in ("flat_norm", "dark_mean", "light_mean")
        if not reference_view and self.truth is not None and \
                self.truth.shape == data.array.shape:
            valid = valid & self.truth.background_mask
        if not reference_view and self.truth is None:
            return None
        summary = region_summary(data.array, valid)
        return {
            "plane_std_pct": summary.plane_std_pct,
            "p1p99_pct": summary.p1p99_pct,
            "masked_to_background": not reference_view,
        }

    def flat_summary(self) -> dict[str, float] | None:
        """Vignetting residual of the normalized flat: how well it was captured."""
        model = self.model
        if model is None:
            return None
        values = model.flat_norm[model.valid_mask]
        if values.size == 0:
            return None
        p1, p99 = np.percentile(values, [1, 99])
        return {
            "p1": float(p1),
            "p50": float(np.median(values)),
            "p99": float(p99),
            "span_pct": float((p99 - p1) * 100.0),
        }

    def evidence(self) -> dict:
        """Numbers shown in the UI and written to the report."""
        payload: dict = {}
        if self.model is not None:
            payload["reference"] = {
                **{k: (float(v) if isinstance(v, (np.floating, float)) else int(v)
                       if isinstance(v, (np.integer, int)) else v)
                   for k, v in self.model.summary().items()},
                "notes": self.model.notes,
                "patch_policy": self.patch_policy,
                "patch_ids": list(self.model.patch_ids),
                "flat_scale": float(self.model.flat_scale),
            }
            payload["defect_components"] = [
                {"id": c.id, "area": c.area, "bbox": list(c.bbox),
                 "category": c.category, "large": c.large}
                for c in self.model.defects.components[:200]
            ]
        if self.correction is not None:
            payload["correction"] = {
                "apply_dark": self.apply_dark,
                "apply_light": self.apply_light,
                "valid_fraction": float(np.count_nonzero(self.correction.valid_mask))
                / self.correction.valid_mask.size,
                "clipped_low": self.correction.clipped_low,
                "clipped_high": self.correction.clipped_high,
                "sample_saturated": int(np.count_nonzero(self.correction.sample_saturated)),
            }
            summary = self.region_summary("corrected")
            if summary is not None:
                payload["correction"]["region"] = {
                    "center_mean": summary.center_mean,
                    "edge_mean": summary.edge_mean,
                    "edge_center_ratio": summary.edge_center_ratio,
                    "plane_std_pct": summary.plane_std_pct,
                    "p1p99_pct": summary.p1p99_pct,
                }
        if self.conditions:
            payload["conditions"] = {
                "dark_exposure_ms": self.conditions.dark_exposure_ms,
                "light_exposure_ms": self.conditions.light_exposure_ms,
                "sample_exposure_ms": self.conditions.sample_exposure_ms,
                "gain_db": self.conditions.gain_db,
                "exposure_tolerance": self.conditions.exposure_tolerance,
                "gain_tolerance_db": self.conditions.gain_tolerance_db,
            }
        payload["issues"] = [
            {"severity": i.severity, "code": i.code, "message": i.message, "detail": i.detail}
            for i in self.issues]
        return payload

    # ------------------------------------------------------------------ #
    # Verification
    # ------------------------------------------------------------------ #
    def verify(self) -> VerificationReport | None:
        model = self.ensure_model()
        correction = self.ensure_correction()
        if model is None or correction is None or self.sample is None or self.truth is None:
            return None
        return evaluate(self.sample.array, model, correction, self.truth,
                        self.config.sat_value)
