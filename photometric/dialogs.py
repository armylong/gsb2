"""Prompt for the light direction of a newly added image."""
from __future__ import annotations

import numpy as np
from PySide6.QtWidgets import (QDialog, QDialogButtonBox, QDoubleSpinBox,
                               QHBoxLayout, QLabel, QVBoxLayout)

from . import vecmath
from .widgets.lightcompass import LightCompass


class DirectionDialog(QDialog):
    def __init__(self, title: str, azimuth: float = 0.0,
                 elevation: float = 45.0, parent=None):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.setModal(True)
        lay = QVBoxLayout(self)
        lay.setSpacing(10)
        hint = QLabel("为这张照片填写光来的方向：方位角自 +x（右）逆时针，仰角自像平面向上。")
        hint.setWordWrap(True)
        lay.addWidget(hint)
        row = QHBoxLayout()
        self.compass = LightCompass(azimuth, elevation)
        row.addWidget(self.compass)
        spins = QVBoxLayout()
        self.az = QDoubleSpinBox()
        self.az.setRange(-360, 360)
        self.az.setDecimals(1)
        self.az.setSuffix("°")
        self.az.setValue(azimuth)
        self.el = QDoubleSpinBox()
        self.el.setRange(0, 90)
        self.el.setDecimals(1)
        self.el.setSuffix("°")
        self.el.setValue(elevation)
        spins.addWidget(QLabel("方位角"))
        spins.addWidget(self.az)
        spins.addWidget(QLabel("仰角"))
        spins.addWidget(self.el)
        spins.addStretch(1)
        row.addLayout(spins)
        lay.addLayout(row)
        self.az.valueChanged.connect(lambda v: self.compass.set_direction(v, self.el.value()))
        self.el.valueChanged.connect(lambda v: self.compass.set_direction(self.az.value(), v))
        self.compass.changed.connect(self._on_compass)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok
                                   | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        lay.addWidget(buttons)

    def _on_compass(self, az: float, el: float) -> None:
        self.az.blockSignals(True)
        self.el.blockSignals(True)
        self.az.setValue(az)
        self.el.setValue(el)
        self.az.blockSignals(False)
        self.el.blockSignals(False)

    def direction(self) -> np.ndarray:
        return vecmath.light_from_az_el(self.az.value(), self.el.value())
