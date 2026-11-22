"""PySide6 本地色觉检查窗口。

布局:
  上方工具条: 导入 PNG / 导入测试颜色 / 保存方案 / 导出对照图
  左侧: 三个联动视图 (普通视觉、红色觉模拟、绿色觉模拟),
        均可点击取色, 透明像素按当前底色合成后读数
  右侧 Tab: 类别(锁定/改色) / 必须区分的配对 / 候选建议 / 底色与阈值
"""
from __future__ import annotations

import json
import os

import numpy as np
from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtGui import QAction, QColor
from PySide6.QtWidgets import (QApplication, QColorDialog, QComboBox,
                               QFileDialog, QFormLayout, QGroupBox,
                               QHBoxLayout, QLabel, QListWidget,
                               QListWidgetItem, QMainWindow, QMessageBox,
                               QPushButton, QSlider, QDoubleSpinBox,
                               QSplitter, QTabWidget, QTableWidget,
                               QTableWidgetItem, QVBoxLayout, QWidget,
                               QInputDialog, QLineEdit)

from . import cvd
from .analysis import (composite_image, conflict_hotspots,
                       pair_pixel_metrics, pixel_color, simulate_frame)
from .colorio import hex_to_rgb, rgb_to_hex
from .palette import (DEFAULT_CONTRAST_MIN, DEFAULT_DE_THRESHOLD, Palette)
from .qtutil import numpy_to_pixmap, qimage_to_numpy
from .recolor import recolor_image


# ---------------------------------------------------------------------------
# 小部件
# ---------------------------------------------------------------------------

class ColorChip(QPushButton):
    """可点击的小色块, 点击弹 QColorDialog。"""

    changed = Signal(object)

    def __init__(self, rgb=(200, 200, 200), editable=True, parent=None):
        super().__init__(parent)
        self._rgb = tuple(int(v) for v in rgb)
        self.setFixedSize(42, 26)
        self.editable = editable
        self.clicked.connect(self._pick)
        self._refresh()

    def _refresh(self):
        self.setText("")
        self.setStyleSheet(
            f"background-color: rgb{self._rgb};"
            "border:1px solid #555; border-radius:3px;")
        self.setToolTip(rgb_to_hex(self._rgb))

    def _pick(self):
        if not self.editable:
            return
        col = QColorDialog.getColor(QColor(*self._rgb), self, "选择颜色")
        if col.isValid():
            self.set_rgb((col.red(), col.green(), col.blue()))

    def set_rgb(self, rgb):
        new = tuple(int(v) for v in rgb)
        if new != self._rgb:
            self._rgb = new
            self._refresh()
            self.changed.emit(self._rgb)

    def rgb(self):
        return self._rgb


class ImageView(QWidget):
    """带棋盘底、缩放、点击取色的图像视图。"""

    picked = Signal(int, int)

    def __init__(self, title, parent=None):
        super().__init__(parent)
        self.title = QLabel(title)
        self.title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.label = QLabel()
        self.label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.label.setMinimumSize(200, 200)
        self.label.setStyleSheet(
            "background: repeating-conic-gradient(#d9d9d9 0% 25%, #fff 0% 50%)"
            " 50% / 16px 16px; border:1px solid #888;")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(2, 2, 2, 2)
        layout.addWidget(self.title)
        layout.addWidget(self.label, 1)
        self._pix = None
        self._zoom = 1.0

    def set_image(self, rgba):
        self._pix = numpy_to_pixmap(rgba)
        self._render()

    def _render(self):
        if self._pix is not None:
            w = max(1, int(self._pix.width() * self._zoom))
            self.label.setPixmap(
                self._pix.scaled(w, w, Qt.AspectRatioMode.KeepAspectRatio,
                                 Qt.TransformationMode.SmoothTransformation))

    def wheelEvent(self, event):
        factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
        self._zoom = float(np.clip(self._zoom * factor, 0.25, 8.0))
        self._render()

    def mousePressEvent(self, event):
        if self._pix is None or not self.label.geometry().contains(event.position().toPoint()):
            return
        lp = self.label.mapFrom(self, event.position().toPoint())
        pm = self.label.pixmap()
        if pm.isNull():
            return
        sx = self._pix.width() / pm.width()
        sy = self._pix.height() / pm.height()
        x = int(lp.x() * sx)
        y = int(lp.y() * sy)
        if 0 <= x < self._pix.width() and 0 <= y < self._pix.height():
            self.picked.emit(x, y)


# ---------------------------------------------------------------------------
# 主窗口
# ---------------------------------------------------------------------------

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("小地图标记色觉检查工具")
        self.resize(1380, 860)

        self.palette = Palette()
        self.rgba = None                 # 原始 RGBA
        self.image_path = None
        self.show_recolored = False
        self.hotspot_pair = None
        self._refresh_timer = QTimer(self)
        self._refresh_timer.setSingleShot(True)
        self._refresh_timer.timeout.connect(self.refresh_all)

        self._build_actions()
        self._build_central()
        self._build_statusbar()
        self._schedule_refresh()

    # ---- 构建 UI ----
    def _build_actions(self):
        tb = self.addToolBar("文件")
        tb.setMovable(False)
        act_open = QAction("导入透明 PNG", self)
        act_open.triggered.connect(self.action_open_png)
        tb.addAction(act_open)
        act_colors = QAction("导入测试颜色", self)
        act_colors.triggered.connect(self.action_import_colors)
        tb.addAction(act_colors)
        tb.addSeparator()
        act_save = QAction("保存方案", self)
        act_save.triggered.connect(self.action_save_project)
        tb.addAction(act_save)
        act_load = QAction("载入方案", self)
        act_load.triggered.connect(self.action_load_project)
        tb.addAction(act_load)
        act_compare = QAction("导出前后对照图", self)
        act_compare.triggered.connect(self.action_export_compare)
        tb.addAction(act_compare)

    def _build_central(self):
        splitter = QSplitter(Qt.Orientation.Horizontal)

        # 左: 控制条 + 三视图
        left = QWidget()
        lv = QVBoxLayout(left)
        lv.setContentsMargins(6, 6, 6, 6)

        ctrl = QHBoxLayout()
        ctrl.addWidget(QLabel("模拟程度"))
        self.severity_slider = QSlider(Qt.Orientation.Horizontal)
        self.severity_slider.setRange(0, 100)
        self.severity_slider.setValue(100)
        self.severity_slider.valueChanged.connect(self._schedule_refresh)
        self.severity_label = QLabel("100%")
        self.severity_slider.valueChanged.connect(
            lambda v: self.severity_label.setText(f"{v}%"))
        ctrl.addWidget(self.severity_slider, 1)
        ctrl.addWidget(self.severity_label)

        self.bg_toggle = QComboBox()
        self.bg_toggle.addItems(["浅底", "深底"])
        self.bg_toggle.currentIndexChanged.connect(self._schedule_refresh)
        ctrl.addWidget(QLabel("底色"))
        ctrl.addWidget(self.bg_toggle)

        self.preview_toggle = QComboBox()
        self.preview_toggle.addItems(["原图", "已接受调色预览"])
        self.preview_toggle.currentIndexChanged.connect(
            self._on_preview_toggle)
        ctrl.addWidget(self.preview_toggle)
        lv.addLayout(ctrl)

        views = QHBoxLayout()
        self.view_normal = ImageView("普通视觉 (源颜色合成)")
        self.view_protan = ImageView(cvd.KIND_LABELS[cvd.PROTAN])
        self.view_deutan = ImageView(cvd.KIND_LABELS[cvd.DEUTAN])
        for v in (self.view_normal, self.view_protan, self.view_deutan):
            v.picked.connect(self.on_pick)
            views.addWidget(v, 1)
        views_w = QWidget()
        views_w.setLayout(views)
        lv.addWidget(views_w, 1)

        self.readout = QLabel("导入 PNG 后点击任意像素取色; "
                              "半透明边缘按实际合成色读数")
        self.readout.setWordWrap(True)
        self.readout.setStyleSheet("padding:4px; background:#f4f4f4;")
        lv.addWidget(self.readout)
        splitter.addWidget(left)

        # 右: Tab
        self.tabs = QTabWidget()
        self.tabs.addTab(self._build_categories_tab(), "类别与锁定")
        self.tabs.addTab(self._build_pairs_tab(), "必须区分的配对")
        self.tabs.addTab(self._build_suggest_tab(), "候选建议")
        self.tabs.addTab(self._build_settings_tab(), "底色与阈值")
        splitter.addWidget(self.tabs)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        self.setCentralWidget(splitter)

    def _build_categories_tab(self):
        w = QWidget()
        v = QVBoxLayout(w)
        bar = QHBoxLayout()
        btn_add = QPushButton("从取色/HEX 新增类别")
        btn_add.clicked.connect(self.add_category_dialog)
        bar.addWidget(btn_add)
        btn_del = QPushButton("删除选中")
        btn_del.clicked.connect(self.delete_selected_category)
        bar.addWidget(btn_del)
        v.addLayout(bar)

        self.cat_table = QTableWidget(0, 5)
        self.cat_table.setHorizontalHeaderLabels(
            ["名称", "当前色", "取样原色", "锁定", "操作"])
        self.cat_table.horizontalHeader().setStretchLastSection(True)
        v.addWidget(self.cat_table, 1)

        tip = QLabel("锁定的颜色不参与自动改色; 取样原色来自导入图, "
                     "改色方案只作用于取样范围内的像素。")
        tip.setWordWrap(True)
        v.addWidget(tip)
        return w

    def _build_pairs_tab(self):
        w = QWidget()
        v = QVBoxLayout(w)
        form = QHBoxLayout()
        self.pair_a = QComboBox()
        self.pair_b = QComboBox()
        form.addWidget(self.pair_a, 1)
        form.addWidget(QLabel("↔"))
        form.addWidget(self.pair_b, 1)
        btn_add = QPushButton("加入必须区分")
        btn_add.clicked.connect(self.add_pair)
        form.addWidget(btn_add)
        v.addLayout(form)

        self.pair_list = QListWidget()
        v.addWidget(self.pair_list, 1)
        btn_rm = QPushButton("移除选中配对")
        btn_rm.clicked.connect(self.remove_selected_pair)
        v.addWidget(btn_rm)

        g = QGroupBox("配对读数 (模拟后, 当前底色)")
        gv = QVBoxLayout(g)
        self.metric_table = QTableWidget(0, 6)
        self.metric_table.setHorizontalHeaderLabels(
            ["配对", "ΔE2000", "反差 A", "反差 B", "色差判定", "反差判定"])
        gv.addWidget(self.metric_table)
        self.hot_btn = QPushButton("在视图上高亮该配对的冲突热点")
        self.hot_btn.setCheckable(True)
        self.hot_btn.toggled.connect(self._on_hotspot_toggle)
        gv.addWidget(self.hot_btn)
        v.addWidget(g, 1)
        return w

    def _build_suggest_tab(self):
        w = QWidget()
        v = QVBoxLayout(w)
        row = QHBoxLayout()
        row.addWidget(QLabel("为哪个类别找候选"))
        self.suggest_target = QComboBox()
        row.addWidget(self.suggest_target, 1)
        btn = QPushButton("生成候选")
        btn.clicked.connect(self.generate_suggestions)
        row.addWidget(btn)
        v.addLayout(row)

        self.suggest_table = QTableWidget(0, 6)
        self.suggest_table.setHorizontalHeaderLabels(
            ["候选色", "HEX", "最小配对ΔE", "最低反差",
             "偏离原色", "问题数"])
        self.suggest_table.setSelectionBehavior(
            QTableWidget.SelectionBehavior.SelectRows)
        v.addWidget(self.suggest_table, 1)

        self.warning_box = QListWidget()
        self.warning_box.setMinimumHeight(110)
        v.addWidget(QLabel("跨组冲突 / 反差预警:"))
        v.addWidget(self.warning_box)

        bar = QHBoxLayout()
        btn_accept = QPushButton("接受所选候选")
        btn_accept.clicked.connect(self.accept_suggestion)
        bar.addWidget(btn_accept)
        btn_reset = QPushButton("该类别恢复取样原色")
        btn_reset.clicked.connect(self.reset_category_color)
        bar.addWidget(btn_reset)
        v.addLayout(bar)
        return w

    def _build_settings_tab(self):
        w = QWidget()
        form = QFormLayout(w)
        self.light_chip = ColorChip(self.palette.light_bg)
        self.dark_chip = ColorChip(self.palette.dark_bg)
        self.light_chip.changed.connect(
            lambda rgb: self._set_bg("light", rgb))
        self.dark_chip.changed.connect(
            lambda rgb: self._set_bg("dark", rgb))
        form.addRow("浅底色", self.light_chip)
        form.addRow("深底色", self.dark_chip)

        self.de_spin = QDoubleSpinBox()
        self.de_spin.setRange(1.0, 60.0)
        self.de_spin.setValue(DEFAULT_DE_THRESHOLD)
        self.de_spin.valueChanged.connect(self._on_threshold_change)
        form.addRow("ΔE2000 最低可分阈值", self.de_spin)

        self.cr_spin = QDoubleSpinBox()
        self.cr_spin.setRange(1.0, 21.0)
        self.cr_spin.setDecimals(2)
        self.cr_spin.setValue(DEFAULT_CONTRAST_MIN)
        self.cr_spin.valueChanged.connect(self._on_threshold_change)
        form.addRow("最低亮度反差 (WCAG)", self.cr_spin)

        self.tol_spin = QDoubleSpinBox()
        self.tol_spin.setRange(2.0, 40.0)
        self.tol_spin.setValue(12.0)
        self.tol_spin.valueChanged.connect(self._schedule_refresh)
        form.addRow("取样容差 (ΔE)", self.tol_spin)

        info = QLabel(
            "判定参考: ΔE2000 < 10 通常难以区分; 非文字图形 WCAG 建议反差 ≥ 3。\n"
            "边缘像素先按 alpha 合成到所选底色, 再参与全部计算。")
        info.setWordWrap(True)
        form.addRow(info)
        return w

    def _build_statusbar(self):
        self.status = QLabel("就绪")
        self.statusBar().addWidget(self.status)

    # ---- 状态/参数 ----
    @property
    def severity(self):
        return self.severity_slider.value() / 100.0

    @property
    def current_bg(self):
        return self.palette.light_bg if self.bg_toggle.currentIndex() == 0 \
            else self.palette.dark_bg

    def _set_bg(self, which, rgb):
        if which == "light":
            self.palette.light_bg = tuple(rgb)
        else:
            self.palette.dark_bg = tuple(rgb)
        self._schedule_refresh()

    def _on_threshold_change(self):
        self.palette.de_threshold = self.de_spin.value()
        self.palette.contrast_min = self.cr_spin.value()
        self._schedule_refresh()

    def _schedule_refresh(self):
        self._refresh_timer.start(60)

    # ---- 文件动作 ----
    def action_open_png(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择透明 PNG", "", "PNG 图像 (*.png)")
        if not path:
            return
        from PySide6.QtGui import QImage
        img = QImage(path)
        if img.isNull():
            QMessageBox.warning(self, "读取失败", f"无法读取 {path}")
            return
        self.rgba = qimage_to_numpy(img)
        self.image_path = path
        self.status.setText(f"已载入 {os.path.basename(path)} "
                            f"({self.rgba.shape[1]}x{self.rgba.shape[0]})")
        self._schedule_refresh()

    def action_import_colors(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择测试颜色 JSON", "", "JSON (*.json)")
        if not path:
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            items = data.get("colors", data if isinstance(data, list) else [])
            n = 0
            name_to_cid = {c.name: c.cid for c in self.palette.categories}
            for item in items:
                if isinstance(item, dict):
                    rgb = tuple(item["rgb"])
                    name = item.get("name", f"类别 {len(self.palette.categories)+1}")
                    locked = bool(item.get("locked", False))
                else:
                    rgb = tuple(item)
                    name = f"类别 {len(self.palette.categories)+1}"
                    locked = False
                cat = self.palette.add_category(rgb, name=name, locked=locked)
                name_to_cid[name] = cat.cid
                n += 1
            for pair in data.get("required_pairs", []):
                if len(pair) == 2 and pair[0] in name_to_cid \
                        and pair[1] in name_to_cid:
                    self.palette.add_pair(name_to_cid[pair[0]],
                                          name_to_cid[pair[1]])
            self.status.setText(
                f"导入 {n} 个测试颜色, "
                f"{len(self.palette.pairs)} 个必须区分的配对")
        except (KeyError, ValueError, json.JSONDecodeError) as exc:
            QMessageBox.warning(self, "导入失败", str(exc))
        self._schedule_refresh()

    def action_save_project(self):
        if self.rgba is None:
            QMessageBox.information(self, "提示", "请先导入 PNG")
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "保存调色方案", "color_scheme.json", "JSON (*.json)")
        if not path:
            return
        project = {
            "image_path": self.image_path,
            "simulation": {
                "kind_default": cvd.DEUTAN,
                "severity": self.severity,
                "background": self.bg_toggle.currentText(),
            },
            "palette": self.palette.to_dict(),
            "accepted_changes": [
                {"cid": c.cid, "name": c.name,
                 "source_rgb": list(c.source_color),
                 "target_rgb": list(c.color), "locked": c.locked}
                for c in self.palette.categories
                if tuple(c.color) != tuple(c.source_color) or c.locked
            ],
            "tolerance": self.tol_spin.value(),
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(project, f, ensure_ascii=False, indent=2)
        self.status.setText(f"方案已保存: {path}")

    def action_load_project(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "载入调色方案", "", "JSON (*.json)")
        if not path:
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                project = json.load(f)
            self.palette = Palette.from_dict(project["palette"])
            sim = project.get("simulation", {})
            self.severity_slider.setValue(
                int(round(sim.get("severity", 1.0) * 100)))
            self.bg_toggle.setCurrentText(sim.get("background", "浅底"))
            self.tol_spin.setValue(project.get("tolerance", 12.0))
            self.de_spin.setValue(self.palette.de_threshold)
            self.cr_spin.setValue(self.palette.contrast_min)
            self.light_chip.set_rgb(self.palette.light_bg)
            self.dark_chip.set_rgb(self.palette.dark_bg)
            self.status.setText(f"已载入方案: {path}")
        except (KeyError, json.JSONDecodeError) as exc:
            QMessageBox.warning(self, "载入失败", str(exc))
        self._schedule_refresh()

    def action_export_compare(self):
        if self.rgba is None:
            QMessageBox.information(self, "提示", "请先导入 PNG")
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "导出前后对照图", "compare.png", "PNG (*.png)")
        if not path:
            return
        original = self.rgba
        recolored = self._current_recolored()
        frames = []
        for bg in (self.palette.light_bg, self.palette.dark_bg):
            row = []
            for img in (original, recolored):
                for kind, sev in ((None, 0.0), (cvd.PROTAN, self.severity),
                                  (cvd.DEUTAN, self.severity)):
                    if kind is None:
                        row.append(composite_image(img, bg).astype(np.uint8))
                    else:
                        row.append(simulate_frame(
                            img, bg, kind, sev).astype(np.uint8))
            frames.append(row)
        canvas = self._stitch_compare(frames)
        numpy_to_pixmap(canvas).save(path, "PNG")
        self.status.setText(f"对照图已导出: {path}")

    def _stitch_compare(self, frames):
        pad = 12
        rows = []
        for row in frames:
            h = max(f.shape[0] for f in row)
            w = sum(f.shape[1] for f in row) + pad * (len(row) - 1)
            canvas = np.full((h, w, 4), 255, np.uint8)
            x = 0
            for f in row:
                canvas[:f.shape[0], x:x + f.shape[1], :3] = f
                canvas[:f.shape[0], x:x + f.shape[1], 3] = 255
                x += f.shape[1] + pad
            rows.append(canvas)
        w = max(r.shape[1] for r in rows)
        h = sum(r.shape[0] for r in rows) + pad
        out = np.full((h, w, 4), 255, np.uint8)
        y = 0
        for r in rows:
            out[y:y + r.shape[0], :r.shape[1]] = r
            y += r.shape[0] + pad
        return out

    # ---- 类别操作 ----
    def add_category_dialog(self):
        text, ok = QInputDialog.getText(
            self, "新增类别", "输入名称与颜色 (名称, #RRGGBB):",
            QLineEdit.Normal, f"类别 {len(self.palette.categories)+1}, #")
        if not ok:
            return
        parts = [p.strip() for p in text.split(",")]
        name = parts[0] or f"类别 {len(self.palette.categories)+1}"
        try:
            rgb = hex_to_rgb(parts[1]) if len(parts) > 1 and parts[1] else (128, 128, 128)
        except ValueError:
            QMessageBox.warning(self, "颜色无效", "请输入 #RRGGBB")
            return
        self.palette.add_category(rgb, name=name)
        self._schedule_refresh()

    def delete_selected_category(self):
        row = self.cat_table.currentRow()
        if row < 0:
            return
        cid = self.palette.categories[row].cid
        self.palette.categories = [c for c in self.palette.categories
                                   if c.cid != cid]
        self.palette.pairs = [p for p in self.palette.pairs
                              if cid not in (p.a, p.b)]
        self._schedule_refresh()

    def _on_preview_toggle(self, idx):
        self.show_recolored = idx == 1
        self._schedule_refresh()

    # ---- 配对操作 ----
    def add_pair(self):
        if self.pair_a.count() < 2:
            QMessageBox.information(self, "提示", "至少需要两个类别")
            return
        a = self.pair_a.currentData()
        b = self.pair_b.currentData()
        try:
            self.palette.add_pair(a, b)
        except ValueError as exc:
            QMessageBox.warning(self, "配对无效", str(exc))
        self._schedule_refresh()

    def remove_selected_pair(self):
        item = self.pair_list.currentItem()
        if item is None:
            return
        a, b = item.data(Qt.ItemDataRole.UserRole)
        self.palette.remove_pair(a, b)
        self._schedule_refresh()

    def _on_hotspot_toggle(self, checked):
        item = self.pair_list.currentItem()
        if checked and item is not None:
            self.hotspot_pair = item.data(Qt.ItemDataRole.UserRole)
        else:
            self.hotspot_pair = None
        self._schedule_refresh()

    # ---- 取色 ----
    def on_pick(self, x, y):
        if self.rgba is None:
            return
        img = self._current_image()
        info = pixel_color(img, y, x, self.current_bg)
        sim_p = cvd.simulate(np.asarray(info["shown_rgb"], float),
                             cvd.PROTAN, self.severity)
        sim_d = cvd.simulate(np.asarray(info["shown_rgb"], float),
                             cvd.DEUTAN, self.severity)
        self.readout.setText(
            f"坐标 ({x},{y})  源 RGBA={info['src_rgb']} "
            f"alpha={info['alpha']:.2f}\n"
            f"合成显示色 {info['shown_hex']}  |  "
            f"protan→{rgb_to_hex(sim_p)}  deutan→{rgb_to_hex(sim_d)}")
        modifiers = QApplication.keyboardModifiers()
        if modifiers & Qt.KeyboardModifier.ShiftModifier:
            self.palette.add_category(
                info["shown_rgb"],
                name=f"取色 {len(self.palette.categories)+1}")
            self.status.setText("Shift+点击: 已把该合成色加入类别")
            self._schedule_refresh()

    # ---- 候选建议 ----
    def generate_suggestions(self):
        if not self.suggest_target.count():
            QMessageBox.information(self, "提示", "请先建立类别")
            return
        cid = self.suggest_target.currentData()
        kind = cvd.DEUTAN
        cands = self.palette.generate_candidates(
            cid, kind, self.severity, max_count=12)
        self.suggest_table.setRowCount(len(cands))
        self._last_candidates = cands
        for i, c in enumerate(cands):
            chip = ColorChip(c["rgb"], editable=False)
            self.suggest_table.setCellWidget(i, 0, chip)
            vals = [c["hex"], f"{c['min_pair_de']:.1f}",
                    f"{c['min_contrast']:.2f}", f"{c['distance']:.1f}",
                    str(c["error_count"])]
            for j, val in enumerate(vals, start=1):
                self.suggest_table.setItem(i, j, QTableWidgetItem(val))
        if cands:
            if getattr(self, "_suggest_sig_connected", False):
                self.suggest_table.itemSelectionChanged.disconnect(
                    self._on_suggest_select)
            self.suggest_table.itemSelectionChanged.connect(
                self._on_suggest_select)
            self._suggest_sig_connected = True
            self.suggest_table.selectRow(0)
            self._show_candidate_warnings(cands[0])

    def _on_suggest_select(self):
        rows = self.suggest_table.selectionModel().selectedRows()
        if rows and hasattr(self, "_last_candidates"):
            idx = rows[0].row()
            if idx < len(self._last_candidates):
                self._show_candidate_warnings(self._last_candidates[idx])

    def _show_candidate_warnings(self, cand):
        self.warning_box.clear()
        if not cand["warnings"]:
            self.warning_box.addItem("✓ 无新增跨组冲突, 两底色反差均达标")
        for w in cand["warnings"]:
            self.warning_box.addItem("⚠ " + w)
        for pd in cand["pair_details"]:
            self.warning_box.addItem(
                f"配对 {pd['pair']}: ΔE={pd['de']:.1f}, "
                f"最低反差={pd['worst_contrast']:.2f}")

    def accept_suggestion(self):
        rows = self.suggest_table.selectionModel().selectedRows()
        if not rows or not hasattr(self, "_last_candidates"):
            return
        cand = self._last_candidates[rows[0].row()]
        target = self.palette.get(cand["cid"])
        if target.locked:
            QMessageBox.warning(self, "类别已锁定",
                                "请先在「类别与锁定」里解锁该类别")
            return
        self.palette.set_color(cand["cid"], cand["rgb"])
        self.status.setText(
            f"已接受候选 {cand['hex']} → {target.name}; "
            "可在视图中切换「已接受调色预览」比较")
        self._schedule_refresh()

    def reset_category_color(self):
        if not self.suggest_target.count():
            return
        cid = self.suggest_target.currentData()
        cat = self.palette.get(cid)
        self.palette.set_color(cid, cat.source_color)
        self.status.setText(f"{cat.name} 已恢复取样原色")
        self._schedule_refresh()

    # ---- 刷新管线 ----
    def _current_image(self):
        if self.show_recolored:
            return self._current_recolored()
        return self.rgba

    def _current_recolored(self):
        if self.rgba is None:
            return None
        src, dst, cids = self.palette.editable_sources_targets()
        changed = [(s, d) for s, d in zip(src, dst)
                   if tuple(s) != tuple(d)]
        if not changed:
            return self.rgba
        s_colors = [s for s, _ in changed]
        d_colors = [d for _, d in changed]
        return recolor_image(self.rgba, s_colors, d_colors,
                             tolerance=self.tol_spin.value())

    def refresh_all(self):
        self._refresh_category_widgets()
        self._refresh_pair_combos()
        self._refresh_pair_list_and_metrics()
        self._refresh_views()
        self._refresh_suggest_targets()

    def _refresh_views(self):
        if self.rgba is None:
            return
        img = self._current_image()
        bg = self.current_bg

        if self.hotspot_pair is not None:
            a, b = self.hotspot_pair
            # 取样归属始终基于原色, 保证调色前后热点定位的是同一批像素
            ca = self.palette.get(a).source_color
            cb = self.palette.get(b).source_color
            base = composite_image(img, bg).astype(np.uint8)
            self.view_normal.set_image(base)
            msgs = []
            for kind, view in ((cvd.PROTAN, self.view_protan),
                               (cvd.DEUTAN, self.view_deutan)):
                frame = simulate_frame(img, bg, kind, self.severity)
                hot, frac, min_de = conflict_hotspots(
                    img, ca, cb, bg, kind, self.severity,
                    threshold=self.palette.de_threshold,
                    tolerance=self.tol_spin.value())
                overlay = frame.astype(np.uint8)
                overlay[hot] = (255, 0, 255)
                view.set_image(overlay)
                msgs.append(f"{kind}: {frac*100:.1f}% 像素 ΔE<"
                            f"{self.palette.de_threshold:g}, 最小ΔE={min_de:.1f}")
            self.status.setText("冲突热点  " + " | ".join(msgs))
            return

        self.view_normal.set_image(
            composite_image(img, bg).astype(np.uint8))
        self.view_protan.set_image(
            simulate_frame(img, bg, cvd.PROTAN, self.severity).astype(np.uint8))
        self.view_deutan.set_image(
            simulate_frame(img, bg, cvd.DEUTAN, self.severity).astype(np.uint8))

    def _refresh_category_widgets(self):
        table = self.cat_table
        table.setRowCount(len(self.palette.categories))
        for i, cat in enumerate(self.palette.categories):
            table.setItem(i, 0, QTableWidgetItem(cat.name))
            cur = ColorChip(cat.color)
            cur.changed.connect(
                lambda rgb, cid=cat.cid: self._edit_category_color(cid, rgb))
            table.setCellWidget(i, 1, cur)
            src = ColorChip(cat.source_color, editable=False)
            table.setCellWidget(i, 2, src)
            lock = QTableWidgetItem("🔒" if cat.locked else "")
            lock.setFlags(lock.flags() | Qt.ItemFlag.ItemIsUserCheckable)
            lock.setCheckState(Qt.CheckState.Checked if cat.locked
                               else Qt.CheckState.Unchecked)
            table.setItem(i, 3, lock)
            btn = QPushButton("解锁" if cat.locked else "锁定")
            btn.clicked.connect(lambda _=False, cid=cat.cid:
                                self._toggle_lock(cid))
            table.setCellWidget(i, 4, btn)
        if not getattr(self, "_lock_connected", False):
            self.cat_table.itemChanged.connect(self._on_lock_item_changed)
            self._lock_connected = True

    def _on_lock_item_changed(self, item):
        if item.column() != 3:
            return
        row = item.row()
        if row < len(self.palette.categories):
            self.palette.categories[row].locked = (
                item.checkState() == Qt.CheckState.Checked)
            self._schedule_refresh()

    def _toggle_lock(self, cid):
        self.palette.toggle_lock(cid)
        self._schedule_refresh()

    def _edit_category_color(self, cid, rgb):
        cat = self.palette.get(cid)
        if cat.locked:
            QMessageBox.warning(self, "类别已锁定", "解锁后才能修改颜色")
            self._schedule_refresh()
            return
        self.palette.set_color(cid, rgb)
        self._schedule_refresh()

    def _refresh_pair_combos(self):
        for combo in (self.pair_a, self.pair_b):
            current = combo.currentData()
            combo.blockSignals(True)
            combo.clear()
            for c in self.palette.categories:
                combo.addItem(f"{c.name} {rgb_to_hex(c.color)}", c.cid)
            idx = combo.findData(current)
            if idx >= 0:
                combo.setCurrentIndex(idx)
            combo.blockSignals(False)

    def _refresh_suggest_targets(self):
        combo = self.suggest_target
        current = combo.currentData()
        combo.blockSignals(True)
        combo.clear()
        for c in self.palette.categories:
            label = c.name + (" (已锁定)" if c.locked else "")
            combo.addItem(label, c.cid)
        idx = combo.findData(current)
        if idx >= 0:
            combo.setCurrentIndex(idx)
        combo.blockSignals(False)

    def _refresh_pair_list_and_metrics(self):
        self.pair_list.clear()
        for p in self.palette.pairs:
            na = self.palette.get(p.a).name
            nb = self.palette.get(p.b).name
            item = QListWidgetItem(f"{na}  ↔  {nb}")
            item.setData(Qt.ItemDataRole.UserRole, (p.a, p.b))
            self.pair_list.addItem(item)

        if self.rgba is None:
            return
        bg = self.current_bg
        img = self._current_image()
        # 调色预览时按新颜色归属像素; 原图视图按取样原色
        use_current = self.show_recolored
        rows = []
        for p in self.palette.pairs:
            cat_a = self.palette.get(p.a)
            cat_b = self.palette.get(p.b)
            ca = cat_a.color if use_current else cat_a.source_color
            cb = cat_b.color if use_current else cat_b.source_color
            m = pair_pixel_metrics(
                img, ca, cb, bg,
                cvd.DEUTAN, self.severity,
                tolerance=self.tol_spin.value())
            if not m["available"]:
                rows.append([f"{self.palette.get(p.a).name}↔"
                             f"{self.palette.get(p.b).name}",
                             "图中未找到", "-", "-", "-", "-"])
                continue
            de_pass = m["de_mean"] >= self.palette.de_threshold
            cr_pass = (m["contrast_a"] >= self.palette.contrast_min
                       and m["contrast_b"] >= self.palette.contrast_min)
            rows.append([
                f"{self.palette.get(p.a).name}↔{self.palette.get(p.b).name}",
                f"{m['de_mean']:.1f} (最小 {m['de_min']:.1f})",
                f"{m['contrast_a']:.2f}", f"{m['contrast_b']:.2f}",
                "通过" if de_pass else "不足",
                "通过" if cr_pass else "不足",
            ])
        self.metric_table.setRowCount(len(rows))
        for i, row in enumerate(rows):
            for j, val in enumerate(row):
                cell = QTableWidgetItem(val)
                if j in (4, 5):
                    cell.setForeground(
                        Qt.GlobalColor.darkGreen if val == "通过"
                        else Qt.GlobalColor.red)
                self.metric_table.setItem(i, j, cell)


def run():
    import sys
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    run()
