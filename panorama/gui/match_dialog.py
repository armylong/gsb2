"""配对检查与控制点编辑对话框。

左侧/右侧显示一对照片，叠加候选匹配（灰）与最终有效匹配（绿），
并支持在两张图上点击添加控制点、拖动/删除已有控制点。
"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, QPoint, Signal
from PySide6.QtGui import QColor, QPainter, QPen, QPixmap
from PySide6.QtWidgets import (
    QDialog, QGroupBox, QHBoxLayout, QLabel, QPushButton, QVBoxLayout,
)

from .helpers import cv_to_qpixmap, safe_message


class ImagePointView(QLabel):
    """可点击/拖动控制点的单张图像视图。"""

    point_added = Signal(float, float)
    point_moved = Signal(int, float, float)

    def __init__(self, title: str, side: str, parent=None):
        super().__init__(parent)
        self.side = side
        self.setAlignment(Qt.AlignCenter)
        self.setMinimumSize(360, 300)
        self.setStyleSheet("background:#202225; color:#ddd;")
        self._base: QPixmap | None = None
        self._points: list[tuple[int, float, float]] = []  # (pid, x, y)
        self._drag_id: int | None = None
        self._title = title
        self.setMouseTracking(True)

    def set_image(self, img_bgr: np.ndarray):
        self._orig = img_bgr
        self._base = cv_to_qpixmap(img_bgr)
        self._refresh()

    def set_points(self, points: list[tuple[int, float, float]]):
        self._points = list(points)
        self._refresh()

    def _display_scale(self) -> tuple[float, float, QPoint]:
        if self._base is None:
            return 1.0, 1.0, QPoint(0, 0)
        scaled = self._base.scaled(
            self.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation
        )
        ox = (self.width() - scaled.width()) // 2
        oy = (self.height() - scaled.height()) // 2
        sx = scaled.width() / max(self._base.width(), 1)
        sy = scaled.height() / max(self._base.height(), 1)
        return sx, sy, QPoint(ox, oy)

    def _to_image_coords(self, pos: QPoint) -> tuple[float, float] | None:
        if self._base is None:
            return None
        sx, sy, origin = self._display_scale()
        x = (pos.x() - origin.x()) / sx
        y = (pos.y() - origin.y()) / sy
        if not (0 <= x <= self._base.width() and 0 <= y <= self._base.height()):
            return None
        return x, y

    def _hit_test(self, pos: QPoint) -> int | None:
        coords = self._to_image_coords(pos)
        if coords is None:
            return None
        x, y = coords
        sx, sy, origin = self._display_scale()
        tol = 8.0 / max(sx, 1e-6)
        for pid, px, py in self._points:
            if abs(px - x) < tol and abs(py - y) < tol:
                return pid
        return None

    def mousePressEvent(self, ev):
        if ev.button() == Qt.LeftButton:
            pid = self._hit_test(ev.position().toPoint())
            if pid is not None:
                self._drag_id = pid
            else:
                coords = self._to_image_coords(ev.position().toPoint())
                if coords:
                    self.point_added.emit(coords[0], coords[1])
        elif ev.button() == Qt.RightButton:
            pid = self._hit_test(ev.position().toPoint())
            if pid is not None:
                self.point_moved.emit(-pid, 0.0, 0.0)  # 负 id 表示删除

    def mouseMoveEvent(self, ev):
        if self._drag_id is not None:
            coords = self._to_image_coords(ev.position().toPoint())
            if coords:
                self.point_moved.emit(self._drag_id, coords[0], coords[1])

    def mouseReleaseEvent(self, ev):
        self._drag_id = None

    def _refresh(self):
        if self._base is None:
            self.setText(self._title)
            return
        scaled = self._base.scaled(
            self.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation
        )
        canvas = scaled.copy()
        painter = QPainter(canvas)
        sx, sy, origin = self._display_scale()
        for k, (pid, x, y) in enumerate(self._points):
            cx, cy = x * sx + origin.x(), y * sy + origin.y()
            pen = QPen(QColor(255, 170, 0), 2)
            painter.setPen(pen)
            painter.setBrush(QColor(255, 170, 0, 180))
            painter.drawEllipse(QPoint(int(cx), int(cy)), 6, 6)
            painter.drawText(QPoint(int(cx) + 8, int(cy) - 8), str(k + 1))
        painter.end()
        self.setPixmap(canvas)

    def resizeEvent(self, ev):
        self._refresh()
        super().resizeEvent(ev)


class MatchDialog(QDialog):
    """查看一对照片的匹配质量并编辑控制点。"""

    controls_changed = Signal()

    def __init__(self, engine, i: int, j: int, parent=None):
        super().__init__(parent)
        self._engine = engine
        self._i, self._j = i, j
        self.setWindowTitle(f"配对检查：{engine.photos[i].name} ↔ {engine.photos[j].name}")
        self.resize(1100, 720)

        self.view_i = ImagePointView(engine.photos[i].name, "i")
        self.view_j = ImagePointView(engine.photos[j].name, "j")
        self.view_i.set_image(engine.photos[i].image)
        self.view_j.set_image(engine.photos[j].image)
        self.view_i.point_added.connect(self._on_add_i)
        self.view_j.point_added.connect(self._on_add_j)
        self.view_i.point_moved.connect(self._on_move_i)
        self.view_j.point_moved.connect(self._on_move_j)

        self.info = QLabel()
        self.info.setWordWrap(True)
        self.info.setStyleSheet("color:#dde;")

        clear_btn = QPushButton("清空本对控制点")
        clear_btn.clicked.connect(self._clear)
        close_btn = QPushButton("关闭并重新拼接")
        close_btn.clicked.connect(self._close)

        top = QHBoxLayout()
        box_i = QGroupBox(f"照片 A：{engine.photos[i].name}（左键加点/拖点，右键删点）")
        box_j = QGroupBox(f"照片 B：{engine.photos[j].name}")
        bi = QVBoxLayout()
        bi.addWidget(self.view_i)
        box_i.setLayout(bi)
        bj = QVBoxLayout()
        bj.addWidget(self.view_j)
        box_j.setLayout(bj)
        top.addWidget(box_i)
        top.addWidget(box_j)

        bottom = QHBoxLayout()
        bottom.addWidget(clear_btn)
        bottom.addStretch(1)
        bottom.addWidget(close_btn)

        root = QVBoxLayout(self)
        root.addWidget(self.info)
        root.addLayout(top, 1)
        root.addLayout(bottom)
        self.refresh()

    # ---- 控制点交互 ----
    def _on_add_i(self, x, y):
        self._pending = (x, y)

    def _on_add_j(self, x, y):
        if not hasattr(self, "_pending"):
            safe_message(
                self, "information", "提示",
                "请先在左侧照片 A 点击选择对应位置",
            )
            return
        ax, ay = self._pending
        del self._pending
        self._engine.add_control_point(self._i, self._j, (ax, ay), (x, y))
        self.controls_changed.emit()
        self.refresh()

    def _on_move_i(self, pid, x, y):
        if pid < 0:
            self._engine.remove_control_point(-pid)
        else:
            self._engine.move_control_point(pid, "i", (x, y))
        self.controls_changed.emit()
        self.refresh()

    def _on_move_j(self, pid, x, y):
        if pid < 0:
            self._engine.remove_control_point(-pid)
        else:
            self._engine.move_control_point(pid, "j", (x, y))
        self.controls_changed.emit()
        self.refresh()

    def _clear(self):
        self._engine.controls.clear_pair(self._i, self._j)
        self.controls_changed.emit()
        self.refresh()

    def _close(self):
        self.accept()

    def refresh(self):
        eng = self._engine
        key = (self._i, self._j) if self._i < self._j else (self._j, self._i)
        # 控制点显示（按当前 i,j 方向）
        cps = eng.controls.get(self._i, self._j)
        pts_i = [(c.pid, *c.pt_i) for c in cps]
        pts_j = [(c.pid, *c.pt_j) for c in cps]
        self.view_i.set_points(pts_i)
        self.view_j.set_points(pts_j)

        rep = eng.last_report
        lines = [f"控制点数量：{len(cps)}（需 ≥ {eng.cfg.min_cp_for_solve} 个才可手动求解）"]
        if rep is not None and key in rep.pair_matches:
            m = rep.pair_matches[key]
            status = "✅ 可信" if m.accepted else "❌ 已拒绝"
            manual = "（含手动控制点）" if m.manual else ""
            lines.append(f"几何关系：{status}{manual}")
            lines.append(
                f"候选匹配 {m.n_raw}，有效内点 {m.n_inliers}，"
                f"内点比例 {m.inlier_ratio:.2f}，RMSE {m.rmse:.2f}px"
            )
            lines.append(
                f"覆盖网格 {m.coverage_cells}，重叠比例 {m.overlap_frac:.1%}，"
                f"综合可信度 {m.confidence:.2f}"
            )
            if m.reasons:
                lines.append("判定依据：" + "；".join(m.reasons))
        else:
            lines.append("尚未生成匹配结果，关闭对话框后将自动重新拼接。")
        self.info.setText("\n".join(lines))
