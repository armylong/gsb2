"""Per-level inspector: low-pass, detail band, mask and the blended band."""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QImage, QPixmap
from PySide6.QtWidgets import (
    QComboBox,
    QDoubleSpinBox,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from ..color import linear_to_rgb8
from .scaling import detail_to_rgb8, gray_to_rgb8


class ImagePane(QWidget):
    """A titled image tile that scales its pixmap to fit."""

    def __init__(self, title: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(2, 2, 2, 2)
        layout.setSpacing(2)
        self.title = QLabel(title)
        self.title.setStyleSheet("font-weight:600;")
        self.image_label = QLabel("—")
        self.image_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.image_label.setMinimumSize(140, 96)
        self.image_label.setSizePolicy(
            QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding
        )
        self.image_label.setStyleSheet("background:#141418; color:#777;")
        layout.addWidget(self.title)
        layout.addWidget(self.image_label, 1)
        self._pixmap: QPixmap | None = None

    def set_rgb(self, rgb: np.ndarray | None) -> None:
        if rgb is None:
            self._pixmap = None
            self.image_label.setPixmap(QPixmap())
            self.image_label.setText("—")
            return
        data = np.ascontiguousarray(rgb)
        height, width = data.shape[:2]
        image = QImage(
            data.data, width, height, 3 * width, QImage.Format.Format_RGB888
        ).copy()
        self._pixmap = QPixmap.fromImage(image)
        self._apply()

    def _apply(self) -> None:
        if self._pixmap is None:
            return
        self.image_label.setPixmap(
            self._pixmap.scaled(
                self.image_label.size(),
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation,
            )
        )

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        self._apply()


class LevelInspector(QWidget):
    level_selected = Signal(int)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.session = None
        self._level_cache: list[dict] = []
        self._residual: dict | None = None

        root = QVBoxLayout(self)
        root.setContentsMargins(6, 6, 6, 6)
        root.setSpacing(6)

        controls = QHBoxLayout()
        controls.addWidget(QLabel("层"))
        self.level_combo = QComboBox()
        self.level_combo.currentIndexChanged.connect(self._on_level_changed)
        controls.addWidget(self.level_combo)
        controls.addSpacing(12)
        controls.addWidget(QLabel("细节增益"))
        self.gain_spin = QDoubleSpinBox()
        self.gain_spin.setRange(0.25, 16.0)
        self.gain_spin.setSingleStep(0.25)
        self.gain_spin.setDecimals(2)
        self.gain_spin.setValue(4.0)
        self.gain_spin.valueChanged.connect(self._refresh_panes)
        controls.addWidget(self.gain_spin)
        controls.addStretch(1)
        root.addLayout(controls)

        info = QGroupBox("当前层")
        info_layout = QVBoxLayout(info)
        self.info_label = QLabel("—")
        self.info_label.setWordWrap(True)
        self.info_label.setStyleSheet("font-family:Menlo,monospace; color:#bbb;")
        info_layout.addWidget(self.info_label)
        root.addWidget(info)

        self.low_a = ImagePane("低频 · 图 A")
        self.low_b = ImagePane("低频 · 图 B")
        self.detail_a = ImagePane("细节 · 图 A（灰底偏置）")
        self.detail_b = ImagePane("细节 · 图 B（灰底偏置）")
        self.mask_pane = ImagePane("掩码低频（1=A，0=B）")
        self.blended_detail = ImagePane("本层混合细节（灰底偏置）")
        self.residual_a = ImagePane("最粗残差 · 图 A")
        self.residual_b = ImagePane("最粗残差 · 图 B")

        grid = QGridLayout()
        grid.setSpacing(4)
        grid.addWidget(self.low_a, 0, 0)
        grid.addWidget(self.low_b, 0, 1)
        grid.addWidget(self.detail_a, 1, 0)
        grid.addWidget(self.detail_b, 1, 1)
        grid.addWidget(self.mask_pane, 2, 0)
        grid.addWidget(self.blended_detail, 2, 1)
        grid.addWidget(self.residual_a, 3, 0)
        grid.addWidget(self.residual_b, 3, 1)
        for row in range(4):
            grid.setRowStretch(row, 1)
        root.addLayout(grid, 1)

        note = QLabel(
            "灰底偏置与增益只用于观察，不进入混合或导出计算；层尺寸为实际分解尺寸"
            "（逐层向上取整），最粗残差单独列出。"
        )
        note.setWordWrap(True)
        note.setStyleSheet("color:#888;")
        root.addWidget(note)

    # ------------------------------------------------------------------
    def set_session(self, session) -> None:
        self.session = session
        self.refresh()

    def refresh(self) -> None:
        if self.session is None:
            return
        self._level_cache = self.session.level_views()
        self._residual = self.session.residual_view()
        count = len(self._level_cache)
        current = self.level_combo.currentIndex()
        self.level_combo.blockSignals(True)
        self.level_combo.clear()
        for index, view in enumerate(self._level_cache):
            height, width = view["size"]
            label = f"第 {index} 层 · {width}×{height}"
            if index == count - 1:
                label += "（最粗）"
            self.level_combo.addItem(label, index)
        self.level_combo.blockSignals(False)
        if count == 0:
            self.info_label.setText("图像尺寸过小，没有可查看的多分辨率层")
            for pane in self._all_panes():
                pane.set_rgb(None)
            return
        index = min(max(current, 0), count - 1)
        self.level_combo.setCurrentIndex(index)
        self._refresh_panes()

    def _all_panes(self) -> tuple[ImagePane, ...]:
        return (
            self.low_a,
            self.low_b,
            self.detail_a,
            self.detail_b,
            self.mask_pane,
            self.blended_detail,
            self.residual_a,
            self.residual_b,
        )

    def _on_level_changed(self, index: int) -> None:
        if self.session is None or not (0 <= index < len(self._level_cache)):
            return
        self.session.set_inspected_level(index)
        self._refresh_panes()
        self.level_selected.emit(index)

    def _refresh_panes(self) -> None:
        index = self.level_combo.currentIndex()
        if not (0 <= index < len(self._level_cache)):
            return
        view = self._level_cache[index]
        gain = float(self.gain_spin.value())
        self.low_a.set_rgb(linear_to_rgb8(view["low_a"]))
        self.low_b.set_rgb(linear_to_rgb8(view["low_b"]))
        self.detail_a.set_rgb(detail_to_rgb8(view["detail_a"], gain))
        self.detail_b.set_rgb(detail_to_rgb8(view["detail_b"], gain))
        self.mask_pane.set_rgb(gray_to_rgb8(view["mask"]))

        mask = view["mask"][..., None].astype(np.float32)
        blended = mask * view["detail_a"] + (1.0 - mask) * view["detail_b"]
        self.blended_detail.set_rgb(detail_to_rgb8(blended, gain))

        if self._residual is not None:
            self.residual_a.set_rgb(linear_to_rgb8(self._residual["low_a"]))
            self.residual_b.set_rgb(linear_to_rgb8(self._residual["low_b"]))
        else:
            self.residual_a.set_rgb(None)
            self.residual_b.set_rgb(None)

        height, width = view["size"]
        a_min, a_max = view["detail_a_range"]
        b_min, b_max = view["detail_b_range"]
        blended_min = float(blended.min())
        blended_max = float(blended.max())
        mask_values = view["mask"]
        self.info_label.setText(
            f"层 {index}  实际尺寸 {width} × {height}（列 × 行）\n"
            f"细节 A  范围 {a_min:+.4f} … {a_max:+.4f}（线性光, 带符号）\n"
            f"细节 B  范围 {b_min:+.4f} … {b_max:+.4f}\n"
            f"混合细节  范围 {blended_min:+.4f} … {blended_max:+.4f}\n"
            f"掩码低频  均值 {float(mask_values.mean()):.4f}  "
            f"范围 {float(mask_values.min()):.4f}…{float(mask_values.max()):.4f}"
        )
