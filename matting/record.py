"""Constraint record: save / load / validate the editable state.

A record contains the image fingerprint, the box, the settings and the stroke
table.  Loading a record onto an image with a different size or content is
refused, so constraints can never be silently applied to the wrong picture.

The module also exposes :func:`state_key`, a hash of everything that influences
the result.  The UI stores the state key together with the last computed alpha
and compares them before exporting, which is how "preview is out of date" is
detected.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .constraints import StrokeHistory
from .engine import ComputeSettings, MattingError, normalize_box
from .imageio import ImageFingerprint, fingerprint_image

FORMAT = "scribble-matting-constraints"
VERSION = 1


class RecordError(MattingError):
    """Record is malformed or does not belong to the current image."""


@dataclass
class ConstraintRecord:
    image: ImageFingerprint
    box: tuple[int, int, int, int]
    settings: dict[str, Any]
    strokes: list[dict]
    saved_at: str = ""
    app_version: str = "1.0"
    warnings: list[str] = field(default_factory=list)

    # --------------------------------------------------------------- building
    @staticmethod
    def build(
        image_bgr: np.ndarray,
        box: tuple[int, int, int, int],
        settings: ComputeSettings,
        history: StrokeHistory,
    ) -> "ConstraintRecord":
        return ConstraintRecord(
            image=fingerprint_image(image_bgr),
            box=tuple(int(v) for v in box),
            settings={
                "refine_radius": int(settings.refine_radius),
                "grabcut_iterations": int(settings.grabcut_iterations),
            },
            strokes=history.to_json(),
            saved_at=_dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        )

    # ------------------------------------------------------------- serialising
    def to_dict(self) -> dict:
        return {
            "format": FORMAT,
            "version": VERSION,
            "saved_at": self.saved_at,
            "app": {"name": "ScribbleMatte", "version": self.app_version},
            "image": self.image.as_dict(),
            "box": list(self.box),
            "settings": self.settings,
            "strokes": self.strokes,
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=2)

    @staticmethod
    def from_json(text: str, image_bgr: np.ndarray) -> "ConstraintRecord":
        try:
            raw = json.loads(text)
        except json.JSONDecodeError as exc:
            raise RecordError(f"约束文件不是有效的 JSON：{exc.msg}。", code="record_bad_json") from exc
        if not isinstance(raw, dict) or raw.get("format") != FORMAT:
            raise RecordError("这不是本工具的约束记录文件。", code="record_bad_format")
        if int(raw.get("version", 0)) != VERSION:
            raise RecordError(
                f"约束记录版本 {raw.get('version')} 不受支持（当前支持版本 {VERSION}）。",
                code="record_version",
            )
        try:
            image_info = ImageFingerprint.from_dict(raw["image"])
            box = tuple(int(v) for v in raw["box"])
            settings = raw.get("settings", {})
            strokes = raw.get("strokes", [])
        except (KeyError, TypeError, ValueError) as exc:
            raise RecordError("约束记录缺少必要字段或字段格式错误。", code="record_bad_fields") from exc

        rec = ConstraintRecord(
            image=image_info,
            box=box,  # type: ignore[arg-type]
            settings=dict(settings) if isinstance(settings, dict) else {},
            strokes=list(strokes) if isinstance(strokes, list) else [],
        )
        rec.validate_for(image_bgr)
        return rec

    # --------------------------------------------------------------- validation
    def validate_for(self, image_bgr: np.ndarray) -> None:
        """Raise a descriptive error unless this record matches ``image_bgr``."""
        current = fingerprint_image(image_bgr)
        if (self.image.width, self.image.height) != (current.width, current.height):
            raise RecordError(
                "约束记录与原图尺寸不一致："
                f"记录为 {self.image.width}×{self.image.height}，当前图为 {current.width}×{current.height}。\n"
                "为避免错位，已拒绝套用。",
                code="record_size_mismatch",
            )
        if self.image.sha256 != current.sha256:
            raise RecordError(
                "约束记录与当前图片内容不一致（尺寸相同但像素不同）。\n"
                "为避免把笔迹画到错误位置，已拒绝套用。请打开记录中对应的原图。",
                code="record_content_mismatch",
            )
        height, width = image_bgr.shape[:2]
        try:
            x0, y0, x1, y1 = normalize_box(self.box, width, height)
        except MattingError as exc:
            raise RecordError(f"约束记录中的选框无效：{exc.message}", code="record_bad_box") from exc
        self.box = (x0, y0, x1, y1)
        if not self.strokes:
            raise RecordError("约束记录中没有笔迹。", code="record_no_strokes")
        for index, item in enumerate(self.strokes):
            if not isinstance(item, dict):
                raise RecordError(f"第 {index + 1} 条笔迹格式错误。", code="record_bad_stroke")
            try:
                kind = int(item["kind"])
                radius = float(item["radius"])
                points = item["points"]
                if kind not in (1, 2, 3):
                    raise ValueError("kind")
                if not (0 < radius <= 400):
                    raise ValueError("radius")
                if not isinstance(points, list) or not points:
                    raise ValueError("points")
                flat = np.asarray(points, dtype=float)
                if flat.ndim != 2 or flat.shape[1] != 2 or not np.isfinite(flat).all():
                    raise ValueError("points")
            except (KeyError, TypeError, ValueError) as exc:
                raise RecordError(
                    f"第 {index + 1} 条笔迹数据损坏，已拒绝套用。", code="record_bad_stroke"
                ) from exc
            margin = radius + 4.0
            if (
                flat[:, 0].min() < -margin
                or flat[:, 0].max() > width + margin
                or flat[:, 1].min() < -margin
                or flat[:, 1].max() > height + margin
            ):
                raise RecordError(
                    f"第 {index + 1} 条笔迹超出图片范围，与原图不匹配，已拒绝套用。",
                    code="record_stroke_out_of_bounds",
                )

    # ------------------------------------------------------------- applying
    def apply_to(self, history: StrokeHistory, settings: ComputeSettings) -> ComputeSettings:
        """Replace ``history`` contents and update ``settings`` in place."""
        if (history.height, history.width) != (self.image.height, self.image.width):
            raise RecordError("约束记录尺寸与画布尺寸不一致。", code="record_size_mismatch")
        loaded = history.load_json(self.strokes)
        if loaded == 0:
            raise RecordError("约束记录中没有可用的笔迹。", code="record_no_strokes")
        settings.box = self.box
        try:
            settings.refine_radius = max(0, min(12, int(self.settings.get("refine_radius", 3))))
            settings.grabcut_iterations = max(
                1, min(10, int(self.settings.get("grabcut_iterations", 4)))
            )
        except (TypeError, ValueError):
            pass
        return settings


def state_key(
    image_bgr: np.ndarray,
    box: tuple[int, int, int, int] | None,
    settings: ComputeSettings,
    history: StrokeHistory,
    *,
    refine_radius: int,
) -> str:
    """Hash every input that can change the result (used to detect staleness)."""
    h = hashlib.sha256()
    h.update(str(image_bgr.shape).encode())
    h.update(np.ascontiguousarray(image_bgr).tobytes())
    h.update(repr(box).encode())
    h.update(f"{int(refine_radius)}|{int(settings.grabcut_iterations)}".encode())
    for stroke in history.iter_active():
        h.update(f"{stroke.kind}:{stroke.radius:.3f}".encode())
        h.update(np.asarray(stroke.points, np.float64).round(3).tobytes())
    return h.hexdigest()
