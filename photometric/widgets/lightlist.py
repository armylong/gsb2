"""Rows describing the light rig: one per image, with a compass and limits."""
from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import (QCheckBox, QDoubleSpinBox, QFrame, QHBoxLayout,
                               QLabel, QToolButton, QVBoxLayout, QWidget)

from .. import theme
from ..rig import LightSpec
from .lightcompass import LightCompass


class LightRow(QFrame):
    changed = Signal()
    activated = Signal()
    loadRequested = Signal()
    removeRequested = Signal()

    def __init__(self, index: int, spec: LightSpec, parent=None):
        super().__init__(parent)
        self._index = index
        self._loading = False
        self.setObjectName("LightCard")
        outer = QHBoxLayout(self)
        outer.setContentsMargins(8, 6, 6, 6)
        outer.setSpacing(8)

        self.thumb = QLabel()
        self.thumb.setFixedSize(44, 44)
        self.thumb.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.thumb.setStyleSheet(
            f"background:#0a0d13; border:1px solid {theme.BORDER}; border-radius:4px;"
            f"color:{theme.MUTED}; font-size:10px;"
        )
        outer.addWidget(self.thumb)

        mid = QVBoxLayout()
        mid.setSpacing(3)
        header = QHBoxLayout()
        header.setSpacing(6)
        self.name = QLabel(spec.name or f"图 {index + 1}")
        self.name.setStyleSheet("font-weight:600; font-size:12px;")
        header.addWidget(self.name, 1)
        self.enabled = QCheckBox("参与")
        self.enabled.setChecked(spec.enabled)
        self.enabled.setToolTip("取消后该方向不参与拟合")
        header.addWidget(self.enabled)
        mid.addLayout(header)

        spin_row = QHBoxLayout()
        spin_row.setSpacing(4)
        az_label = QLabel("方位")
        az_label.setStyleSheet(f"color:{theme.MUTED}; font-size:10px;")
        self.az = QDoubleSpinBox()
        self.az.setRange(-360.0, 360.0)
        self.az.setDecimals(0)
        self.az.setSingleStep(5.0)
        self.az.setSuffix("°")
        self.az.setValue(spec.azimuth_deg)
        self.az.setFixedWidth(66)
        el_label = QLabel("仰角")
        el_label.setStyleSheet(f"color:{theme.MUTED}; font-size:10px;")
        self.el = QDoubleSpinBox()
        self.el.setRange(0.0, 90.0)
        self.el.setDecimals(0)
        self.el.setSingleStep(5.0)
        self.el.setSuffix("°")
        self.el.setValue(spec.elevation_deg)
        self.el.setFixedWidth(62)
        spin_row.addWidget(az_label)
        spin_row.addWidget(self.az)
        spin_row.addWidget(el_label)
        spin_row.addWidget(self.el)
        spin_row.addStretch(1)
        mid.addLayout(spin_row)

        self.note = QLabel("")
        self.note.setWordWrap(False)
        self.note.setTextInteractionFlags(Qt.TextInteractionFlag.NoTextInteraction)
        self.note.setStyleSheet(f"color:{theme.MUTED}; font-size:10px;")
        mid.addWidget(self.note)
        outer.addLayout(mid, 1)

        right = QVBoxLayout()
        right.setSpacing(2)
        self.compass = LightCompass(spec.azimuth_deg, spec.elevation_deg)
        self.compass.setMinimumSize(64, 64)
        self.compass.setMaximumSize(74, 74)
        right.addWidget(self.compass)
        buttons = QHBoxLayout()
        buttons.setSpacing(2)
        buttons.addStretch(1)
        self.load_btn = QToolButton()
        self.load_btn.setText("图")
        self.load_btn.setToolTip("为这一行载入一张灰度照片")
        self.load_btn.setFixedSize(22, 20)
        self.remove_btn = QToolButton()
        self.remove_btn.setText("×")
        self.remove_btn.setToolTip("移除这一行")
        self.remove_btn.setFixedSize(22, 20)
        buttons.addWidget(self.load_btn)
        buttons.addWidget(self.remove_btn)
        right.addLayout(buttons)
        outer.addLayout(right)

        self.az.valueChanged.connect(self._on_spin)
        self.el.valueChanged.connect(self._on_spin)
        self.compass.changed.connect(self._on_compass)
        self.enabled.toggled.connect(self._emit_changed)
        self.load_btn.clicked.connect(self.loadRequested.emit)
        self.remove_btn.clicked.connect(self.removeRequested.emit)
        self._apply_style(selected=False)

    # ------------------------------------------------------------------ state
    def spec(self) -> LightSpec:
        label = self.name.text() or f"图 {self._index + 1}"
        return LightSpec(self.az.value(), self.el.value(), self.enabled.isChecked(), label)

    def set_spec(self, spec: LightSpec) -> None:
        self._loading = True
        self.name.setText(spec.name or f"图 {self._index + 1}")
        self.az.setValue(spec.azimuth_deg)
        self.el.setValue(spec.elevation_deg)
        self.enabled.setChecked(spec.enabled)
        self.compass.set_direction(spec.azimuth_deg, spec.elevation_deg)
        self._loading = False

    def set_thumbnail(self, rgb) -> None:
        if rgb is None:
            self.thumb.setPixmap(QPixmap())
            self.thumb.setText("无图")
            return
        from .imageview import numpy_to_qimage

        image = numpy_to_qimage(rgb)
        pix = QPixmap.fromImage(image).scaled(
            42, 42, Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation)
        self.thumb.setPixmap(pix)
        self.thumb.setText("")

    def set_note(self, text: str, warn: bool = False) -> None:
        self.note.setText(text)
        self.note.setToolTip(text)
        colour = theme.WARN if warn else theme.MUTED
        self.note.setStyleSheet(f"color:{colour}; font-size:10px;")

    def set_loadable(self, visible: bool) -> None:
        self.load_btn.setVisible(visible)

    def set_removable(self, visible: bool) -> None:
        self.remove_btn.setVisible(visible)

    def _apply_style(self, selected: bool) -> None:
        border = theme.ACCENT if selected else theme.BORDER
        self.setStyleSheet(
            f"QFrame#LightCard {{ background:{theme.PANEL_ALT}; border-radius:7px; "
            f"border:1px solid {border}; }}"
        )

    def set_selected(self, selected: bool) -> None:
        self._apply_style(selected)

    # ----------------------------------------------------------------- events
    def _on_spin(self):
        if self._loading:
            return
        self._loading = True
        self.compass.set_direction(self.az.value(), self.el.value())
        self._loading = False
        self._emit_changed()

    def _on_compass(self, az: float, el: float):
        if self._loading:
            return
        self._loading = True
        self.az.setValue(az)
        self.el.setValue(el)
        self._loading = False
        self._emit_changed()

    def _emit_changed(self):
        if self._loading:
            return
        self.changed.emit()
        self.activated.emit()

    def mousePressEvent(self, event):
        self.activated.emit()
        super().mousePressEvent(event)


class LightList(QWidget):
    """Container that keeps the rows in sync with a list of LightSpec."""

    changed = Signal()
    selected = Signal(int)
    loadRequested = Signal(int)
    removeRequested = Signal(int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._layout = QVBoxLayout(self)
        self._layout.setContentsMargins(0, 0, 4, 0)
        self._layout.setSpacing(6)
        self._layout.addStretch(1)
        self._rows: list[LightRow] = []
        self._active = 0

    def set_rows(self, specs: list[LightSpec], loadable: bool = False,
                 removable: bool = False) -> None:
        while self._rows:
            row = self._rows.pop()
            row.setParent(None)
            row.deleteLater()
        for i, spec in enumerate(specs):
            row = LightRow(i, spec)
            row.changed.connect(self.changed.emit)
            row.activated.connect(lambda i=i: self._activate(i))
            row.loadRequested.connect(lambda i=i: self.loadRequested.emit(i))
            row.removeRequested.connect(lambda i=i: self.removeRequested.emit(i))
            row.set_loadable(loadable)
            row.set_removable(removable)
            self._layout.insertWidget(self._layout.count() - 1, row)
            self._rows.append(row)
        if self._active >= len(self._rows):
            self._active = 0
        self._refresh_highlight()

    def specs(self) -> list[LightSpec]:
        return [row.spec() for row in self._rows]

    def set_notes(self, notes: list[str], oks: list[bool]) -> None:
        for i, row in enumerate(self._rows):
            if i < len(notes):
                row.set_note(notes[i], warn=not (i < len(oks) and oks[i]))
            else:
                row.set_note("")

    def set_thumbnail(self, index: int, rgb) -> None:
        if 0 <= index < len(self._rows):
            self._rows[index].set_thumbnail(rgb)

    def set_name(self, index: int, name: str) -> None:
        if 0 <= index < len(self._rows):
            self._rows[index].name.setText(name)

    def active_index(self) -> int:
        return self._active

    def count(self) -> int:
        return len(self._rows)

    def _activate(self, index: int) -> None:
        self._active = index
        self._refresh_highlight()
        self.selected.emit(index)

    def _refresh_highlight(self) -> None:
        for i, row in enumerate(self._rows):
            row.set_selected(i == self._active)
