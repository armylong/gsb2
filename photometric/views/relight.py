"""Tab 4 — re-light the estimated surface under a new direction.

The exposure ("亮度") of the preview is stored on the shared context, not in
this widget: switching scenes, tabs or re-running the solver must not reset
it, and the slider always shows the value the preview is actually using.
"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QComboBox, QDoubleSpinBox, QHBoxLayout, QLabel,
                               QPushButton, QSlider, QVBoxLayout, QWidget)

from .. import rendering, theme, vecmath
from ..context import AppContext
from ..solver import SolveResult
from ..widgets.common import SectionTitle
from ..widgets.gizmo import NormalGizmo
from ..widgets.imageview import ImageView, Marker
from ..widgets.lightcompass import LightCompass


class RelightView(QWidget):
    def __init__(self, context: AppContext, parent=None):
        super().__init__(parent)
        self.ctx = context
        self._direction = np.array([-0.42, 0.45, 0.79])
        self._direction /= np.linalg.norm(self._direction)
        self._compare = "truth"     # truth | input | off

        root = QVBoxLayout(self)
        root.setContentsMargins(12, 12, 12, 12)
        root.setSpacing(10)

        header = QHBoxLayout()
        title = QLabel("重新照明")
        title.setObjectName("Title")
        header.addWidget(title)
        header.addStretch(1)
        self.status = QLabel("")
        self.status.setObjectName("Muted")
        header.addWidget(self.status)
        root.addLayout(header)

        body = QHBoxLayout()
        body.setSpacing(12)

        left = QVBoxLayout()
        left.setSpacing(8)
        compare_row = QHBoxLayout()
        compare_row.setSpacing(8)
        compare_row.addWidget(QLabel("对照："))
        self.compare_box = QComboBox()
        self.compare_box.addItem("与内置真实方向对照", "truth")
        self.compare_box.addItem("与输入照片对照", "input")
        self.compare_box.addItem("只看重光照", "off")
        self.compare_box.currentIndexChanged.connect(self._on_compare_changed)
        compare_row.addWidget(self.compare_box)
        compare_row.addStretch(1)
        self.match_label = QLabel("")
        self.match_label.setStyleSheet(f"color:{theme.MUTED}; font-size:11px;")
        compare_row.addWidget(self.match_label)
        left.addLayout(compare_row)

        self.view = ImageView()
        self.view.setMinimumSize(420, 420)
        self.view.set_badge("重光照预览")
        self.view.pixelHovered.connect(self._on_hover)
        self.view.left.connect(lambda: self.ctx.set_hover(None))
        self.view.pixelClicked.connect(self._on_click)
        left.addWidget(self.view, 1)
        body.addLayout(left, 1)

        side = QVBoxLayout()
        side.setSpacing(8)
        side.addWidget(SectionTitle("新光方向"))
        row = QHBoxLayout()
        row.setSpacing(10)
        self.compass = LightCompass(*vecmath.az_el_from_direction(self._direction))
        self.compass.changed.connect(self._on_compass)
        row.addWidget(self.compass)
        spins = QVBoxLayout()
        spins.setSpacing(6)
        az_row = QHBoxLayout()
        az_row.addWidget(QLabel("方位"))
        self.az = QDoubleSpinBox()
        self.az.setRange(-360.0, 360.0)
        self.az.setDecimals(1)
        self.az.setSuffix("°")
        self.az.setValue(self.compass.azimuth())
        self.az.valueChanged.connect(self._on_az_el)
        az_row.addWidget(self.az)
        spins.addLayout(az_row)
        el_row = QHBoxLayout()
        el_row.addWidget(QLabel("仰角"))
        self.el = QDoubleSpinBox()
        self.el.setRange(0.0, 90.0)
        self.el.setDecimals(1)
        self.el.setSuffix("°")
        self.el.setValue(self.compass.elevation())
        self.el.valueChanged.connect(self._on_az_el)
        el_row.addWidget(self.el)
        spins.addLayout(el_row)
        spins.addStretch(1)
        row.addLayout(spins)
        row.addStretch(1)
        side.addLayout(row)

        self.gizmo = NormalGizmo()
        self.gizmo.setMinimumHeight(140)
        side.addWidget(self.gizmo)

        side.addWidget(SectionTitle("亮度（切换视图不会重置）"))
        bright_row = QHBoxLayout()
        self.exposure = QSlider(Qt.Orientation.Horizontal)
        self.exposure.setRange(10, 400)
        self.exposure.setValue(int(round(self.ctx.brightness * 100)))
        self.exposure.valueChanged.connect(self._on_exposure)
        self.exposure_label = QLabel(f"{self.ctx.brightness * 100:.0f}%")
        self.exposure_label.setFixedWidth(46)
        bright_row.addWidget(self.exposure, 1)
        bright_row.addWidget(self.exposure_label)
        reset = QPushButton("100%")
        reset.setFixedWidth(52)
        reset.clicked.connect(lambda: self.ctx.set_brightness(1.0))
        bright_row.addWidget(reset)
        side.addLayout(bright_row)
        self.exposure_note = QLabel(
            "斜线区域是没有可靠法线的像素，重光照时按“未知”处理，而不是当作黑色表面。")
        self.exposure_note.setObjectName("Muted")
        self.exposure_note.setWordWrap(True)
        self.exposure_note.setStyleSheet(f"color:{theme.MUTED}; font-size:11px;")
        side.addWidget(self.exposure_note)

        self.quick = QHBoxLayout()
        self.quick.setSpacing(6)
        for text, az, el in [("正面", 0, 80), ("左前", 315, 45), ("右前", 45, 45), ("顶光", 90, 75)]:
            btn = QPushButton(text)
            btn.clicked.connect(lambda _=False, a=az, e=el: self._set_direction(a, e))
            self.quick.addWidget(btn)
        side.addLayout(self.quick)
        side.addStretch(1)

        side_host = QWidget()
        side_host.setLayout(side)
        side_host.setFixedWidth(340)
        body.addWidget(side_host)
        root.addLayout(body, 1)

        context.resultChanged.connect(self.refresh)
        context.sceneChanged.connect(self._on_scene)
        context.brightnessChanged.connect(self._on_brightness_changed)
        context.pinnedChanged.connect(self.refresh)
        context.hoverChanged.connect(lambda: self.view.set_cursor(self.ctx.hover))

    def _on_hover(self, x: int, y: int) -> None:
        if self.ctx.result is None:
            return
        self.ctx.set_hover((x % max(1, self.ctx.result.width), y))

    def _on_click(self, x: int, y: int) -> None:
        if self.ctx.result is None:
            return
        # in compare mode the probe refers to the reconstruction half
        if self._compare != "off":
            x = x % max(1, self.ctx.result.width)
        self.ctx.set_pinned((x, y))

    # ----------------------------------------------------------------- state
    def _set_direction(self, az: float, el: float) -> None:
        self.compass.set_direction(az, el)
        self._on_compass(az, el)

    def _on_compass(self, az: float, el: float) -> None:
        self._direction = vecmath.light_from_az_el(az, el)
        for widget in (self.az, self.el):
            widget.blockSignals(True)
        self.az.setValue(az)
        self.el.setValue(el)
        for widget in (self.az, self.el):
            widget.blockSignals(False)
        self.refresh()

    def _on_az_el(self) -> None:
        self.compass.set_direction(self.az.value(), self.el.value())
        self._direction = vecmath.light_from_az_el(self.az.value(), self.el.value())
        self.refresh()

    def _on_exposure(self, value: int) -> None:
        self.ctx.set_brightness(value / 100.0)

    def _on_brightness_changed(self) -> None:
        value = int(round(self.ctx.brightness * 100))
        if self.exposure.value() != value:
            self.exposure.blockSignals(True)
            self.exposure.setValue(value)
            self.exposure.blockSignals(False)
        self.exposure_label.setText(f"{self.ctx.brightness * 100:.0f}%")
        self.refresh()

    def _on_compare_changed(self) -> None:
        self._compare = self.compare_box.currentData()
        self.refresh()

    def _on_scene(self) -> None:
        self.refresh()

    # ---------------------------------------------------------------- render
    def refresh(self) -> None:
        result = self.ctx.result
        self.exposure_label.setText(f"{self.ctx.brightness * 100:.0f}%")
        if result is None:
            self.view.set_image(None, "先运行一次估计")
            self.gizmo.set_normal(None)
            return
        # Both halves of the comparison must receive the same exposure,
        # otherwise the brightness slider would look like a physical change.
        exposure = self.ctx.brightness
        if self._compare == "truth" and self.ctx.scene and self.ctx.scene.has_truth:
            shading = self._truth_match(result)
            base = rendering.gray_rgb(np.clip(shading * exposure, 0.0, 1.0))
            self.match_label.setText(self._match_text(result, shading))
            self.view.set_badge(f"真实方向下的渲染 · 亮度 {exposure * 100:.0f}%")
        elif self._compare == "input":
            row = self._nearest_light(result.directions, self._direction)
            scene_light = result.scene_index(row)
            photo = np.clip(self.ctx.scene.images[scene_light].astype(np.float64) * exposure,
                            0.0, 1.0)
            base = rendering.status_overlay(rendering.gray_rgb(photo), result, row)
            self.match_label.setText(f"最接近的输入照片：图 {scene_light + 1}")
            self.view.set_badge(f"输入照片 图 {scene_light + 1}（同样亮度）")
        else:
            base = None
            self.match_label.setText("")
        est = rendering.relight(result, self._direction)
        est = rendering.hatch_unknown(result, est)
        est_rgb = rendering.gray_rgb(np.clip(est * exposure, 0.0, 1.0))
        pin = self.ctx.pinned
        if base is None:
            self.view.set_image(est_rgb)
            self.view.set_show_arrows(False)
            self.status.setText("单幅重光照预览")
            self.view.set_pinned(pin)
            self.view.set_markers([])
        else:
            self.view.set_image(np.concatenate([base, est_rgb], axis=1))
            self.view.set_show_arrows(False)
            self.status.setText("左：对照 · 右：用估出的法线重新照明")
            # the composite is twice as wide; mark both halves of the probe
            self.view.set_pinned(None if pin is None else (pin[0] + result.width, pin[1]))
            self.view.set_markers([] if pin is None else [Marker(pin[0], pin[1], "对照", theme.WARN)])
        self.view.set_cursor(self.ctx.hover)
        self.gizmo.set_normal(self._direction)
        self.gizmo.set_lights(result.directions)

    def _truth_match(self, result: SolveResult) -> np.ndarray:
        """Render the ground-truth surface under the same new light (no exposure)."""
        scene = self.ctx.scene
        if scene is None or scene.truth_normals is None:
            return rendering.relight(result, self._direction)
        l = vecmath.normalize(self._direction)
        lam = np.clip(np.einsum("hwj,j->hw", scene.truth_normals, l), 0.0, None)
        albedo = scene.truth_albedo if scene.truth_albedo is not None else result.albedo
        img = np.clip(albedo * lam, 0.0, 1.0)
        img[~scene.object_mask] = 0.0
        return img

    def _match_text(self, result: SolveResult, truth_shading: np.ndarray) -> str:
        est = np.clip(rendering.relight(result, self._direction), 0.0, 1.0)
        sel = result.valid
        if not np.any(sel):
            return ""
        diff = np.abs(est[sel] - truth_shading[sel])
        return f"有效区域平均亮度差 {diff.mean():.3f}（与真值）"

    @staticmethod
    def _nearest_light(directions: np.ndarray, target: np.ndarray) -> int:
        dots = directions @ vecmath.normalize(target)
        return int(np.argmax(dots))
