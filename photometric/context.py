"""Shared application state.

The context is the single source of truth the views read from.  Anything the
user might tweak while switching between views — notably the exposure used by
the relight preview — lives here rather than inside a view, so switching
images or tabs never silently resets it.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from PySide6.QtCore import QObject, Signal

from .rig import LightSpec
from .solver import SolverOptions, SolveResult
from .synthesis import Scene


@dataclass
class ProbeReading:
    light: int
    intensity: float
    predicted: float
    residual: float
    status: int


@dataclass
class ProbeInfo:
    x: int
    y: int
    valid: bool
    reason: int
    normal: np.ndarray | None
    albedo: float
    uncertainty_deg: float
    readings_used: int
    confidence: float
    readings: list[ProbeReading] = field(default_factory=list)


class AppContext(QObject):
    sceneChanged = Signal()
    resultChanged = Signal()
    pinnedChanged = Signal()
    brightnessChanged = Signal()
    rigChanged = Signal()
    hoverChanged = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.scene: Scene | None = None
        self.result: SolveResult | None = None
        self.options = SolverOptions()
        self._pinned: tuple[int, int] | None = None
        self._brightness = 1.0
        self._hover: tuple[int, int] | None = None
        self.solving = False
        self.last_solve_seconds: float | None = None
        self.message = ""
        self.pinned_light = 0
        self.active_light = 0

    # ------------------------------------------------------------------ scene
    def set_scene(self, scene: Scene) -> None:
        self.scene = scene
        self.result = None
        self._pinned = None
        self.sceneChanged.emit()

    def specs(self) -> list[LightSpec]:
        return list(self.scene.lights) if self.scene else []

    def set_specs(self, specs: list[LightSpec]) -> None:
        if self.scene is None:
            return
        self.scene.lights = specs
        self.rigChanged.emit()

    # ----------------------------------------------------------------- result
    def set_result(self, result: SolveResult) -> None:
        self.result = result
        self.resultChanged.emit()

    # ------------------------------------------------------------------ probe
    @property
    def pinned(self) -> tuple[int, int] | None:
        return self._pinned

    def set_pinned(self, xy: tuple[int, int] | None) -> None:
        if xy == self._pinned:
            return
        self._pinned = xy
        self.pinnedChanged.emit()

    def set_active_light(self, index: int) -> None:
        self.active_light = int(index)

    @property
    def hover(self) -> tuple[int, int] | None:
        return self._hover

    def set_hover(self, xy: tuple[int, int] | None) -> None:
        if xy == self._hover:
            return
        self._hover = xy
        self.hoverChanged.emit()

    # -------------------------------------------------------------- brightness
    @property
    def brightness(self) -> float:
        return self._brightness

    def set_brightness(self, value: float) -> None:
        value = float(min(max(value, 0.1), 4.0))
        if abs(value - self._brightness) < 1e-6:
            return
        self._brightness = value
        self.brightnessChanged.emit()

    # ------------------------------------------------------------------ probe
    def probe_info(self, xy: tuple[int, int] | None = None) -> ProbeInfo | None:
        if self.result is None or self.scene is None:
            return None
        coords = xy if xy is not None else self._pinned
        if coords is None:
            return None
        x, y = coords
        res = self.result
        if not (0 <= x < res.width and 0 <= y < res.height):
            return None
        valid = bool(res.valid[y, x])
        normal = res.normals[y, x] if valid else None
        readings = []
        for row in range(len(res.directions)):
            scene_light = res.scene_index(row)
            img = float(self.scene.images[scene_light, y, x])
            pred = float(res.predictions[row, y, x])
            readings.append(ProbeReading(scene_light, img, pred, img - pred,
                                         int(res.status[row, y, x])))
        return ProbeInfo(
            x=x, y=y,
            valid=valid,
            reason=int(res.reason[y, x]),
            normal=None if normal is None else np.array(normal, dtype=np.float64),
            albedo=float(res.albedo[y, x]),
            uncertainty_deg=float(res.uncertainty_deg[y, x]),
            readings_used=int(res.readings_used[y, x]),
            confidence=float(res.confidence[y, x]),
            readings=readings,
        )
