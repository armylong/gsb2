"""主窗口: 原图选角 + 校正结果双视图, 标注点同步, 导出。"""
from __future__ import annotations

import json
import math
from pathlib import Path

import cv2
import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QPen
from PySide6.QtWidgets import (
    QButtonGroup,
    QFileDialog,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QRadioButton,
    QSpinBox,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from . import exporter
from . import geometry as geo
from . import sample_gen
from .widgets import ImageView, np_to_qpixmap

MAX_SIDE = 1600
MAX_POINTS = 20

MODE_EDIT = "edit"
MODE_CORNERS = "corners"
MODE_ADD = "add"


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("平面标签透视校正与标注")

        self.image = None          # BGR 原图
        self.image_path = None
        self.corners = None        # [4][2] 或含 None 的槽位 (TL,TR,BR,BL)
        self._placing = 0
        self.H = None              # 最近一次有效单应
        self.warped = None         # 最近一次有效校正图
        self.points = {}           # id -> [x, y] 源图坐标
        self.mode = MODE_EDIT
        self._drag = None          # ("corner", i) | ("point", id, "src"|"dst")
        self._updating = False

        self._build_ui()
        self.statusBar().showMessage("请打开图片或载入内置样例")

    # ------------------------------------------------------------------ UI
    def _build_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        lay = QHBoxLayout(central)

        splitter = QSplitter()
        self.src_view = ImageView()
        self.dst_view = ImageView()
        self.src_view.overlay = self._draw_src_overlay
        self.dst_view.overlay = self._draw_dst_overlay
        splitter.addWidget(self._titled("原图 (选角 / 标注)", self.src_view))
        splitter.addWidget(self._titled("校正结果", self.dst_view))
        splitter.setSizes([700, 700])
        lay.addWidget(splitter, 1)
        lay.addWidget(self._build_panel())

        for view, side in ((self.src_view, "src"), (self.dst_view, "dst")):
            view.pressed.connect(lambda x, y, b, s=side: self._on_pressed(s, x, y, b))
            view.dragged.connect(lambda x, y, s=side: self._on_dragged(s, x, y))
            view.released.connect(lambda x, y, s=side: self._on_released(s, x, y))
            view.hovered.connect(lambda x, y, ok, s=side: self._on_hovered(s, x, y, ok))

    def _titled(self, title, view):
        w = QWidget()
        v = QVBoxLayout(w)
        v.setContentsMargins(2, 2, 2, 2)
        v.addWidget(QLabel(title))
        v.addWidget(view, 1)
        return w

    def _build_panel(self):
        panel = QWidget()
        panel.setFixedWidth(360)
        v = QVBoxLayout(panel)

        self.btn_open = QPushButton("打开图片…")
        self.btn_open.clicked.connect(self.open_image)
        self.btn_sample = QPushButton("载入内置样例 (斜拍标签)")
        self.btn_sample.clicked.connect(self.load_sample)
        v.addWidget(self.btn_open)
        v.addWidget(self.btn_sample)

        # 模式
        box_mode = QGroupBox("交互模式")
        mv = QVBoxLayout(box_mode)
        self.rb_edit = QRadioButton("拖动编辑 (拖角点/标注点, 右键删点)")
        self.rb_corners = QRadioButton("依次选角 (左上→右上→右下→左下)")
        self.rb_add = QRadioButton("添加标注点 (两侧均可, 最多 20 个)")
        self.rb_edit.setChecked(True)
        self._mode_group = QButtonGroup(self)
        for rb, mode in (
            (self.rb_edit, MODE_EDIT),
            (self.rb_corners, MODE_CORNERS),
            (self.rb_add, MODE_ADD),
        ):
            self._mode_group.addButton(rb)
            mv.addWidget(rb)
            rb.toggled.connect(lambda checked, m=mode: checked and self._set_mode(m))
        v.addWidget(box_mode)

        # 输出尺寸
        box_size = QGroupBox("输出尺寸 (像素, ≤1600)")
        sv = QHBoxLayout(box_size)
        self.spin_w = QSpinBox(minimum=1, maximum=MAX_SIDE, value=sample_gen.LABEL_W)
        self.spin_h = QSpinBox(minimum=1, maximum=MAX_SIDE, value=sample_gen.LABEL_H)
        sv.addWidget(QLabel("宽"))
        sv.addWidget(self.spin_w)
        sv.addWidget(QLabel("高"))
        sv.addWidget(self.spin_h)
        self.spin_w.valueChanged.connect(self._recompute)
        self.spin_h.valueChanged.connect(self._recompute)
        v.addWidget(box_size)

        # 角点表
        v.addWidget(QLabel("角点坐标 (源图像素, 可编辑)"))
        self.tbl_corners = QTableWidget(4, 3)
        self.tbl_corners.setHorizontalHeaderLabels(["角", "X", "Y"])
        self.tbl_corners.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        for i, name in enumerate(geo.CORNER_NAMES):
            item = QTableWidgetItem(f"{i + 1} {name}")
            item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
            self.tbl_corners.setItem(i, 0, item)
        self.tbl_corners.setFixedHeight(140)
        self.tbl_corners.itemChanged.connect(self._on_corner_edited)
        v.addWidget(self.tbl_corners)

        # 标注点表
        v.addWidget(QLabel("标注点 (源图 / 校正图坐标, 原点为左上像素中心)"))
        self.tbl_points = QTableWidget(0, 6)
        self.tbl_points.setHorizontalHeaderLabels(
            ["编号", "源X", "源Y", "校正X", "校正Y", "状态"]
        )
        self.tbl_points.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.tbl_points.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.tbl_points.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        v.addWidget(self.tbl_points, 1)
        self.btn_del = QPushButton("删除选中标注点")
        self.btn_del.clicked.connect(self._delete_selected_point)
        v.addWidget(self.btn_del)

        self.btn_export = QPushButton("导出校正图 / 检查图 / 坐标 JSON…")
        self.btn_export.clicked.connect(self.export_results)
        v.addWidget(self.btn_export)
        return panel

    # ------------------------------------------------------------ 图片载入
    def _load_image_array(self, path):
        data = np.fromfile(str(path), dtype=np.uint8)
        return cv2.imdecode(data, cv2.IMREAD_COLOR)

    def open_image(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "打开图片", "", "图片 (*.png *.jpg *.jpeg)"
        )
        if not path:
            return
        img = self._load_image_array(path)
        if img is None:
            QMessageBox.warning(self, "打开失败", "无法解码该图片 (仅支持 PNG/JPEG)")
            return
        h, w = img.shape[:2]
        if max(h, w) > MAX_SIDE:
            QMessageBox.warning(
                self, "图片过大", f"长边 {max(h, w)} 像素, 超过上限 {MAX_SIDE}"
            )
            return
        self._set_image(img, path)

    def load_sample(self):
        paths = sample_gen.ensure_sample(Path.cwd() / "sample_data")
        img = self._load_image_array(paths["photo"])
        meta = json.loads(paths["meta"].read_text(encoding="utf-8"))
        self._set_image(img, str(paths["photo"]))
        c = meta["corners"]
        self.corners = [list(map(float, c[n])) for n in geo.CORNER_NAMES]
        self._placing = 4
        self.spin_w.setValue(meta["label_size"][0])
        self.spin_h.setValue(meta["label_size"][1])
        self.rb_edit.setChecked(True)
        self._recompute()
        self.statusBar().showMessage(
            f"已载入样例 {paths['photo']} (删除 sample_data 后可重新生成, 内容一致)"
        )

    def _set_image(self, img, path):
        self.image = img
        self.image_path = path
        self.corners = None
        self._placing = 0
        self.points = {}
        self.H = None
        self.warped = None
        self.src_view.set_pixmap(np_to_qpixmap(img))
        self.dst_view.clear_image()
        self.rb_corners.setChecked(True)
        self._refresh_all()
        self.statusBar().showMessage(
            "已打开图片, 请在原图上按 左上→右上→右下→左下 顺序点击四个角"
        )

    # ------------------------------------------------------------ 模式
    def _set_mode(self, mode):
        self.mode = mode
        if mode == MODE_CORNERS and self.image is not None:
            # 进入选角模式即重新开始依次选角
            self.corners = None
            self._placing = 0
            self._refresh_all()
            self.statusBar().showMessage("依次点击: 1 左上 → 2 右上 → 3 右下 → 4 左下")

    # ------------------------------------------------------------ 交互
    def _on_pressed(self, side, x, y, button):
        if self.image is None:
            return
        if button == int(Qt.MouseButton.RightButton):
            pid = self._hit_point(side, x, y)
            if pid is not None:
                del self.points[pid]
                self._refresh_all()
                self.statusBar().showMessage(f"已删除标注点 {pid}")
            return
        if button != int(Qt.MouseButton.LeftButton):
            return

        if side == "src" and self.mode == MODE_CORNERS:
            self._place_corner(x, y)
        elif self.mode == MODE_ADD:
            if side == "src":
                self._add_point_from_src(x, y)
            else:
                self._add_point_from_dst(x, y)
        else:  # 拖动编辑
            if side == "src":
                i = self._hit_corner(x, y)
                if i is not None:
                    self._drag = ("corner", i)
                    return
            pid = self._hit_point(side, x, y)
            if pid is not None:
                self._drag = ("point", pid, side)

    def _on_dragged(self, side, x, y):
        if self._drag is None or self.image is None:
            return
        h, w = self.image.shape[:2]
        kind = self._drag[0]
        if kind == "corner":
            x = min(max(x, 0.0), w - 1.0)
            y = min(max(y, 0.0), h - 1.0)
            self.corners[self._drag[1]] = [x, y]
            self._update_corner_table()
            self.src_view.viewport().update()
        else:
            pid, pside = self._drag[1], self._drag[2]
            if pside == "src":
                x = min(max(x, 0.0), w - 1.0)
                y = min(max(y, 0.0), h - 1.0)
                self.points[pid] = [x, y]
            else:
                if self.H is None:
                    return
                src = geo.map_points(geo.invert(self.H), [(x, y)])[0]
                if not (0 <= src[0] <= w - 1 and 0 <= src[1] <= h - 1):
                    return  # 拖出原图范围, 忽略
                self.points[pid] = [float(src[0]), float(src[1])]
            self._refresh_points()

    def _on_released(self, side, x, y):
        if self._drag is None:
            return
        kind = self._drag[0]
        self._drag = None
        if kind == "corner":
            self._recompute()
        else:
            self._refresh_all()

    def _on_hovered(self, side, x, y, inside):
        if not inside:
            return
        if side == "src":
            self.statusBar().showMessage(f"源图坐标 ({x:.1f}, {y:.1f})")
        else:
            msg = f"校正图坐标 ({x:.1f}, {y:.1f})"
            if self.H is not None:
                src = geo.map_points(geo.invert(self.H), [(x, y)])[0]
                msg += f"  ↔  源图 ({src[0]:.1f}, {src[1]:.1f})"
            self.statusBar().showMessage(msg)

    # ------------------------------------------------------------ 角点
    def _place_corner(self, x, y):
        if self.corners is None:
            self.corners = [None, None, None, None]
            self._placing = 0
        self.corners[self._placing] = [x, y]
        self._placing += 1
        if self._placing >= 4:
            self.rb_edit.setChecked(True)
            self._recompute()
        else:
            name = geo.CORNER_NAMES[self._placing]
            self.statusBar().showMessage(
                f"已记录角 {self._placing}, 请点击下一个角: {self._placing + 1} {name}"
            )
            self._refresh_all()

    def _hit_corner(self, x, y):
        if not self._corners_complete():
            return None
        tol = 10.0 / max(self.src_view.scale_factor(), 1e-6)
        best, bd = None, tol
        for i, (cx, cy) in enumerate(self.corners):
            d = math.hypot(cx - x, cy - y)
            if d < bd:
                best, bd = i, d
        return best

    def _corners_complete(self):
        return self.corners is not None and all(c is not None for c in self.corners)

    def _on_corner_edited(self, item):
        if self._updating or not self._corners_complete():
            return
        row, col = item.row(), item.column()
        if col == 0:
            return
        try:
            val = float(item.text())
        except ValueError:
            self._update_corner_table()
            return
        h, w = self.image.shape[:2]
        val = min(max(val, 0.0), (w if col == 1 else h) - 1.0)
        self.corners[row][col - 1] = val
        self._recompute()

    # ------------------------------------------------------------ 标注点
    def _next_point_id(self):
        for i in range(1, MAX_POINTS + 1):
            if i not in self.points:
                return i
        return None

    def _add_point_from_src(self, x, y):
        if not self._corners_complete():
            self.statusBar().showMessage("请先完成四角选取, 再添加标注点")
            return
        pid = self._next_point_id()
        if pid is None:
            self.statusBar().showMessage(f"最多 {MAX_POINTS} 个标注点")
            return
        if not geo.inside_quad(self.corners, (x, y)):
            self.statusBar().showMessage("点击在选区之外, 未添加标注")
            return
        self.points[pid] = [x, y]
        self._refresh_all()
        self.statusBar().showMessage(f"已添加标注点 {pid}")

    def _add_point_from_dst(self, x, y):
        if self.H is None:
            self.statusBar().showMessage("当前无有效校正, 不能在结果侧添加标注")
            return
        pid = self._next_point_id()
        if pid is None:
            self.statusBar().showMessage(f"最多 {MAX_POINTS} 个标注点")
            return
        h, w = self.image.shape[:2]
        src = geo.map_points(geo.invert(self.H), [(x, y)])[0]
        if not (0 <= src[0] <= w - 1 and 0 <= src[1] <= h - 1):
            self.statusBar().showMessage("该位置映射到原图之外, 未添加标注")
            return
        self.points[pid] = [float(src[0]), float(src[1])]
        self._refresh_all()
        self.statusBar().showMessage(
            f"已添加标注点 {pid} (源图 {src[0]:.1f}, {src[1]:.1f})"
        )

    def _hit_point(self, side, x, y):
        view = self.src_view if side == "src" else self.dst_view
        tol = 8.0 / max(view.scale_factor(), 1e-6)
        best, bd = None, tol
        for pid, coords in self._iter_points_view(side):
            d = math.hypot(coords[0] - x, coords[1] - y)
            if d < bd:
                best, bd = pid, d
        return best

    def _iter_points_view(self, side):
        """生成 (pid, (x, y)) — 指定视图坐标系下的点位置。"""
        for pid, (sx, sy) in self.points.items():
            if side == "src":
                yield pid, (sx, sy)
            else:
                if self.H is None or not self._point_inside(pid):
                    continue
                u, v = geo.map_points(self.H, [(sx, sy)])[0]
                yield pid, (u, v)

    def _point_inside(self, pid):
        if not self._corners_complete():
            return False
        return geo.inside_quad(self.corners, self.points[pid])

    def _delete_selected_point(self):
        row = self.tbl_points.currentRow()
        if row < 0:
            self.statusBar().showMessage("请先在表格中选中一个标注点")
            return
        pid = int(self.tbl_points.item(row, 0).text())
        self.points.pop(pid, None)
        self._refresh_all()
        self.statusBar().showMessage(f"已删除标注点 {pid}")

    # ------------------------------------------------------------ 校正
    def _recompute(self):
        if self.image is None or not self._corners_complete():
            self._refresh_all()
            return
        ok, msg = geo.validate_quad(self.corners)
        if ok:
            w, h = self.spin_w.value(), self.spin_h.value()
            self.H = geo.homography(self.corners, w, h)
            self.warped = geo.warp(self.image, self.corners, w, h)
            self.dst_view.set_pixmap(np_to_qpixmap(self.warped))
            self.statusBar().showMessage(f"校正有效, 输出 {w}×{h}")
        else:
            self.statusBar().showMessage(f"四边形无效: {msg} —— 保留上次有效校正")
        self._refresh_all()

    # ------------------------------------------------------------ 刷新
    def _refresh_all(self):
        self._update_corner_table()
        self._refresh_points()
        self.src_view.viewport().update()
        self.dst_view.viewport().update()

    def _update_corner_table(self):
        self._updating = True
        try:
            for i in range(4):
                for col in (1, 2):
                    if self._corners_complete():
                        text = f"{self.corners[i][col - 1]:.2f}"
                    else:
                        text = "-"
                    item = self.tbl_corners.item(i, col)
                    if item is None:
                        item = QTableWidgetItem()
                        self.tbl_corners.setItem(i, col, item)
                    item.setText(text)
        finally:
            self._updating = False

    def _refresh_points(self):
        self._updating = True
        try:
            self.tbl_points.setRowCount(0)
            for pid in sorted(self.points):
                sx, sy = self.points[pid]
                if self.H is not None:
                    u, v = geo.map_points(self.H, [(sx, sy)])[0]
                    dst_text = (f"{u:.2f}", f"{v:.2f}")
                else:
                    dst_text = ("-", "-")
                if not self._corners_complete():
                    status = "-"
                else:
                    status = "区内" if self._point_inside(pid) else "区外"
                row = self.tbl_points.rowCount()
                self.tbl_points.insertRow(row)
                for col, text in enumerate(
                    [str(pid), f"{sx:.2f}", f"{sy:.2f}", *dst_text, status]
                ):
                    self.tbl_points.setItem(row, col, QTableWidgetItem(text))
        finally:
            self._updating = False
        self.src_view.viewport().update()
        self.dst_view.viewport().update()

    # ------------------------------------------------------------ 绘制
    def _draw_src_overlay(self, painter):
        s = 1.0 / max(self.src_view.scale_factor(), 1e-6)
        font = painter.font()
        font.setPixelSize(max(1, int(13 * s)))
        painter.setFont(font)

        if self.corners is not None:
            if self._corners_complete():
                ok, _ = geo.validate_quad(self.corners)
                color = QColor(0, 210, 90) if ok else QColor(230, 60, 60)
                painter.setPen(QPen(color, 2 * s))
                for i in range(4):
                    a = self.corners[i]
                    b = self.corners[(i + 1) % 4]
                    painter.drawLine(QPointF(a[0], a[1]), QPointF(b[0], b[1]))
                    self._draw_dir_marker(painter, a, b, s, color)
            for i, c in enumerate(self.corners):
                if c is None:
                    continue
                r = 6 * s
                painter.setPen(QPen(QColor(20, 20, 20), 1.5 * s))
                painter.setBrush(QColor(255, 170, 0))
                painter.drawRect(QRectF(c[0] - r, c[1] - r, 2 * r, 2 * r))
                painter.drawText(
                    QPointF(c[0] + 8 * s, c[1] - 8 * s),
                    f"{i + 1} {geo.CORNER_NAMES[i]}",
                )

        for pid, (x, y) in self.points.items():
            inside = self._point_inside(pid)
            color = QColor(0, 120, 255) if inside else QColor(150, 150, 150)
            r = 5 * s
            painter.setPen(QPen(QColor(255, 255, 255), 1 * s))
            painter.setBrush(color)
            painter.drawEllipse(QPointF(x, y), r, r)
            painter.setPen(QPen(color, 1.5 * s))
            painter.drawText(QPointF(x + 7 * s, y - 7 * s), str(pid))

    def _draw_dst_overlay(self, painter):
        if self.H is None:
            return
        s = 1.0 / max(self.dst_view.scale_factor(), 1e-6)
        font = painter.font()
        font.setPixelSize(max(1, int(13 * s)))
        painter.setFont(font)
        for pid, (u, v) in self._iter_points_view("dst"):
            color = QColor(0, 120, 255)
            r = 5 * s
            painter.setPen(QPen(QColor(255, 255, 255), 1 * s))
            painter.setBrush(color)
            painter.drawEllipse(QPointF(u, v), r, r)
            painter.setPen(QPen(color, 1.5 * s))
            painter.drawText(QPointF(u + 7 * s, v - 7 * s), str(pid))

    def _draw_dir_marker(self, painter, a, b, s, color):
        """在边中点画一个小箭头, 标明 TL→TR→BR→BL 方向。"""
        mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        dx, dy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(dx, dy)
        if n < 1e-9:
            return
        ux, uy = dx / n, dy / n
        L, Wd = 9 * s, 5 * s
        p1 = QPointF(mx + ux * L, my + uy * L)
        p2 = QPointF(mx - uy * Wd, my + ux * Wd)
        p3 = QPointF(mx + uy * Wd, my - ux * Wd)
        painter.setBrush(color)
        painter.setPen(QPen(color, 1 * s))
        painter.drawPolygon([p1, p2, p3])

    # ------------------------------------------------------------ 导出
    def export_results(self):
        if self.warped is None or self.H is None or not self._corners_complete():
            QMessageBox.information(self, "无法导出", "请先完成一次有效校正")
            return
        out_dir = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not out_dir:
            return
        records = []
        for pid in sorted(self.points):
            sx, sy = self.points[pid]
            u, v = geo.map_points(self.H, [(sx, sy)])[0]
            records.append(
                {
                    "id": pid,
                    "source": [sx, sy],
                    "rectified": [float(u), float(v)],
                    "in_region": self._point_inside(pid),
                }
            )
        paths = exporter.export_all(
            out_dir,
            self.warped,
            records,
            self.corners,
            (self.spin_w.value(), self.spin_h.value()),
            Path(self.image_path).name if self.image_path else "",
        )
        QMessageBox.information(
            self,
            "导出完成",
            "\n".join(str(p) for p in paths.values()),
        )
