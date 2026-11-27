"""Dock widget showing the inspection point and its mirrored position."""

from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import (
    QComboBox,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from .canvas import qimage_from_bgr
from .magnifier import draw_crosshair, paired_crops


class MagnifierDock(QWidget):
    pointChanged = Signal(float, float)

    def __init__(self, get_document, parent=None):
        super().__init__(parent)
        self._get_doc = get_document
        self.point: tuple[float, float] | None = None
        self.radius = 36
        self.zoom = 6
        self.step = 0.25

        root = QVBoxLayout(self)

        info = QGroupBox("配对放大 (浮点像素)")
        v = QVBoxLayout(info)
        row = QHBoxLayout()
        self.lbl_a = QLabel("选定点")
        self.lbl_b = QLabel("镜像点")
        for lb in (self.lbl_a, self.lbl_b):
            lb.setAlignment(Qt.AlignmentFlag.AlignCenter)
            lb.setStyleSheet("font-weight:600;")
        self.view_a = QLabel()
        self.view_b = QLabel()
        for vw in (self.view_a, self.view_b):
            vw.setAlignment(Qt.AlignmentFlag.AlignCenter)
            vw.setMinimumSize(1, 1)
        col_a, col_b = QVBoxLayout(), QVBoxLayout()
        col_a.addWidget(self.lbl_a)
        col_a.addWidget(self.view_a)
        col_b.addWidget(self.lbl_b)
        col_b.addWidget(self.view_b)
        row.addLayout(col_a)
        row.addLayout(col_b)
        v.addLayout(row)

        self.coords = QLabel("在画布上点击「取点」后，或用下方按钮移动")
        self.coords.setWordWrap(True)
        v.addWidget(self.coords)

        grid = QHBoxLayout()
        self.btn_pick = QPushButton("取点模式")
        self.btn_pick.setCheckable(True)
        grid.addWidget(self.btn_pick)
        zoom_box = QComboBox()
        zoom_box.addItems(["4x", "6x", "8x", "12x"])
        zoom_box.setCurrentIndex(1)
        zoom_box.currentTextChanged.connect(self._on_zoom)
        grid.addWidget(zoom_box)
        step_box = QComboBox()
        step_box.addItems(["0.1 px", "0.25 px", "1 px", "5 px"])
        step_box.setCurrentIndex(1)
        step_box.currentTextChanged.connect(self._on_step)
        grid.addWidget(step_box)
        v.addLayout(grid)

        moves = QHBoxLayout()
        for text, dx, dy in [
            ("←", -1, 0), ("→", 1, 0), ("↑", 0, -1), ("↓", 0, 1),
        ]:
            b = QPushButton(text)
            b.clicked.connect(lambda _=False, ddx=dx, ddy=dy: self.nudge(ddx, ddy))
            moves.addWidget(b)
        v.addLayout(moves)

        root.addWidget(info)
        root.addStretch(1)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)

    def _on_zoom(self, text: str) -> None:
        self.zoom = int(text.replace("x", ""))
        self.update_views()

    def _on_step(self, text: str) -> None:
        self.step = float(text.split()[0])

    def set_point(self, x: float, y: float) -> None:
        self.point = (float(x), float(y))
        self.update_views()
        self.pointChanged.emit(x, y)

    def nudge(self, dx: int, dy: int) -> None:
        if self.point is None:
            return
        self.set_point(self.point[0] + dx * self.step, self.point[1] + dy * self.step)

    def keyPressEvent(self, event):
        k = event.key()
        delta = {
            Qt.Key.Key_Left: (-1, 0), Qt.Key.Key_Right: (1, 0),
            Qt.Key.Key_Up: (0, -1), Qt.Key.Key_Down: (0, 1),
        }.get(k)
        if delta:
            self.nudge(*delta)
            return
        super().keyPressEvent(event)

    def update_views(self) -> None:
        doc = self._get_doc()
        if doc is None or doc.line is None or self.point is None:
            return
        crop_a, crop_b, q, inside = paired_crops(
            doc.image, doc.line, self.point, radius=self.radius, zoom=self.zoom
        )
        crop_a = draw_crosshair(crop_a, self.zoom)
        crop_b = draw_crosshair(crop_b, self.zoom)
        self.view_a.setPixmap(QPixmap.fromImage(qimage_from_bgr(crop_a)))
        self.view_b.setPixmap(QPixmap.fromImage(qimage_from_bgr(crop_b)))
        in_a = inside[0].all()
        in_b = inside[1].all()
        self.coords.setText(
            f"选定点 ({self.point[0]:.2f}, {self.point[1]:.2f}) "
            f"[{'图内' if in_a else '含图外'}]\n"
            f"镜像点 ({q[0]:.2f}, {q[1]:.2f}) "
            f"[{'图内' if in_b else '含图外/缺口候选'}]"
        )
