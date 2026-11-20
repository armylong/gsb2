"""hdr_tool.app — PySide6 图形界面。

布局: 左侧控制面板 + 右侧三个同步视图(参考/对齐 | 合成亮度 | 最终成品)。
三个视图共享缩放与滚动, 单击任一视图即可在相同画布坐标处探查:
各输入值、合成线性亮度与成品颜色。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt, QRectF, QTimer, Signal
from PySide6.QtGui import QColor, QImage, QPainter, QPen, QPixmap
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QDoubleSpinBox, QFileDialog,
    QGraphicsPixmapItem, QGraphicsScene, QGraphicsView, QGridLayout,
    QGroupBox, QHBoxLayout, QLabel, QListWidget, QMainWindow, QMessageBox,
    QPushButton, QSlider, QSpinBox, QSplitter, QTextEdit, QVBoxLayout,
    QWidget,
)

from . import core, samples

MAGENTA = (255, 0, 255)  # 无法恢复区域的统一标记色


# ---------------------------------------------------------------- 视图

class ViewPane(QGraphicsView):
    """单个图像视图: 支持命名图层、缩放联动、点击探针。"""

    probeRequested = Signal(float, float)   # 画布坐标
    zoomRequested = Signal(float)           # 缩放倍率

    def __init__(self, title):
        super().__init__()
        self.title = title
        self.scene = QGraphicsScene(self)
        self.setScene(self.scene)
        self.setRenderHint(QPainter.SmoothPixmapTransform)
        self.setDragMode(QGraphicsView.NoDrag)
        self.setBackgroundBrush(QColor(40, 40, 40))
        self._items = {}
        self._zorder = {"ref": 0, "sel": 1, "main": 0}
        self._press_pos = None
        self._dragging = False
        pen = QPen(QColor(255, 0, 255), 0)
        self.cross = self.scene.addEllipse(-6, -6, 12, 12, pen)
        self.cross.setZValue(20)
        self.cross.setVisible(False)
        self._crop_item = self.scene.addRect(
            QRectF(), QPen(QColor(255, 220, 0), 0, Qt.DashLine))
        self._crop_item.setZValue(10)
        self._crop_item.setVisible(False)

    # -- 图层 --
    def set_pixmap(self, name, arr, pos=(0, 0), opacity=1.0):
        item = self._items.get(name)
        if arr is None:
            if item is not None:
                item.setVisible(False)
            return
        h, w = arr.shape[:2]
        data = np.ascontiguousarray(arr)
        qimg = QImage(data.data, w, h, 3 * w, QImage.Format_RGB888).copy()
        if item is None:
            item = QGraphicsPixmapItem()
            item.setZValue(self._zorder.get(name, 0))
            self.scene.addItem(item)
            self._items[name] = item
        item.setPixmap(QPixmap.fromImage(qimg))
        item.setPos(*pos)
        item.setOpacity(opacity)
        item.setVisible(True)
        self.scene.setSceneRect(self.scene.itemsBoundingRect())

    def set_crop_rect(self, rect):
        if rect is None:
            self._crop_item.setVisible(False)
        else:
            x0, y0, x1, y1 = rect
            self._crop_item.setRect(QRectF(x0, y0, x1 - x0, y1 - y0))
            self._crop_item.setVisible(True)

    # -- 交互 --
    def wheelEvent(self, e):
        self.zoomRequested.emit(1.25 if e.angleDelta().y() > 0 else 0.8)

    def mousePressEvent(self, e):
        if e.button() == Qt.LeftButton:
            self._press_pos = e.position()
            self._dragging = False
        super().mousePressEvent(e)

    def mouseMoveEvent(self, e):
        if self._press_pos is not None:
            d = e.position() - self._press_pos
            if abs(d.x()) + abs(d.y()) > 6:
                self._dragging = True
            if self._dragging:
                self.horizontalScrollBar().setValue(
                    self.horizontalScrollBar().value() - int(d.x()))
                self.verticalScrollBar().setValue(
                    self.verticalScrollBar().value() - int(d.y()))
                self._press_pos = e.position()
        super().mouseMoveEvent(e)

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.LeftButton and self._press_pos is not None:
            if not self._dragging:
                p = self.mapToScene(e.position().toPoint())
                self.probeRequested.emit(p.x(), p.y())
            self._press_pos = None
            self._dragging = False
        super().mouseReleaseEvent(e)


# ---------------------------------------------------------------- 数据

class Shot:
    def __init__(self, path, img):
        self.path = str(path)
        self.img = img          # RGB uint8
        self.ev = 0.0
        self.dx = 0
        self.dy = 0

    @property
    def name(self):
        return Path(self.path).name


# ---------------------------------------------------------------- 主窗口

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("HDR 合成工具 (sRGB 多曝光)")
        self.shots: list[Shot] = []
        self.hdr = None
        self.valid = None
        self.crop = None
        self.final_u8 = None
        self.zoom = 1.0
        self._syncing_scroll = False
        self._updating = False

        self._merge_timer = QTimer(self)
        self._merge_timer.setSingleShot(True)
        self._merge_timer.timeout.connect(self._remerge)

        central = QWidget()
        self.setCentralWidget(central)
        lay = QHBoxLayout(central)
        lay.addWidget(self._build_panel())

        self.view_ref = ViewPane("参考 / 对齐")
        self.view_hdr = ViewPane("合成亮度 (log 灰度, 品红=无法恢复)")
        self.view_final = ViewPane("最终成品")
        self._views = (self.view_ref, self.view_hdr, self.view_final)
        views = QSplitter(Qt.Horizontal)
        for v in self._views:
            box = QGroupBox(v.title)
            vb = QVBoxLayout(box)
            vb.addWidget(v)
            views.addWidget(box)
            v.probeRequested.connect(self._probe)
            v.zoomRequested.connect(self._zoom_by)
            v.horizontalScrollBar().valueChanged.connect(
                lambda val, s=v: self._sync_scroll(s, "h", val))
            v.verticalScrollBar().valueChanged.connect(
                lambda val, s=v: self._sync_scroll(s, "v", val))
        lay.addWidget(views, 1)

    # ---------------- 左侧面板 ----------------
    def _build_panel(self):
        panel = QWidget()
        panel.setFixedWidth(360)
        v = QVBoxLayout(panel)

        v.addWidget(QLabel("照片组 (3-5 张, 同尺寸, PNG/JPEG 无透明度, 长边≤1600)"))
        row = QHBoxLayout()
        btn_add = QPushButton("添加照片…")
        btn_add.clicked.connect(self._add_photos)
        btn_del = QPushButton("删除选中")
        btn_del.clicked.connect(self._del_selected)
        row.addWidget(btn_add)
        row.addWidget(btn_del)
        v.addLayout(row)
        self.list = QListWidget()
        self.list.currentRowChanged.connect(self._on_select)
        v.addWidget(self.list)

        grid = QGridLayout()
        self.spin_ev = QDoubleSpinBox()
        self.spin_ev.setRange(-20, 20)
        self.spin_ev.setDecimals(2)
        self.spin_ev.setSingleStep(1.0)
        self.spin_dx = QSpinBox()
        self.spin_dx.setRange(-core.SHIFT_LIMIT, core.SHIFT_LIMIT)
        self.spin_dy = QSpinBox()
        self.spin_dy.setRange(-core.SHIFT_LIMIT, core.SHIFT_LIMIT)
        grid.addWidget(QLabel("曝光档数 EV (±1 = 曝光量翻倍/减半)"), 0, 0)
        grid.addWidget(self.spin_ev, 0, 1)
        grid.addWidget(QLabel("水平位移 dx (像素)"), 1, 0)
        grid.addWidget(self.spin_dx, 1, 1)
        grid.addWidget(QLabel("垂直位移 dy (像素)"), 2, 0)
        grid.addWidget(self.spin_dy, 2, 1)
        v.addLayout(grid)
        self.spin_ev.valueChanged.connect(self._param_changed)
        self.spin_dx.valueChanged.connect(self._param_changed)
        self.spin_dy.valueChanged.connect(self._param_changed)

        self.chk_clip = QCheckBox("显示截断区域 (红=亮部, 蓝=暗部)")
        self.chk_align = QCheckBox("半透明叠加参考图 (对齐检查)")
        self.chk_clip.stateChanged.connect(self._refresh_reference_view)
        self.chk_align.stateChanged.connect(self._refresh_reference_view)
        v.addWidget(self.chk_clip)
        v.addWidget(self.chk_align)
        row = QHBoxLayout()
        row.addWidget(QLabel("叠加不透明度"))
        self.slider_opacity = QSlider(Qt.Horizontal)
        self.slider_opacity.setRange(0, 100)
        self.slider_opacity.setValue(55)
        self.slider_opacity.valueChanged.connect(self._refresh_reference_view)
        row.addWidget(self.slider_opacity)
        v.addLayout(row)

        v.addWidget(QLabel("调色 (每次从合成结果重算, 不累积)"))
        grid = QGridLayout()
        self.spin_exp = QDoubleSpinBox()
        self.spin_exp.setRange(-8, 8)
        self.spin_exp.setSingleStep(0.25)
        self.spin_comp = QDoubleSpinBox()
        self.spin_comp.setRange(0, 1)
        self.spin_comp.setSingleStep(0.05)
        self.spin_comp.setValue(0.5)
        self.spin_sat = QDoubleSpinBox()
        self.spin_sat.setRange(0, 3)
        self.spin_sat.setSingleStep(0.05)
        self.spin_sat.setValue(1.0)
        grid.addWidget(QLabel("整体曝光 (档)"), 0, 0)
        grid.addWidget(self.spin_exp, 0, 1)
        grid.addWidget(QLabel("明暗压缩 (0-1)"), 1, 0)
        grid.addWidget(self.spin_comp, 1, 1)
        grid.addWidget(QLabel("饱和度 (1=原样)"), 2, 0)
        grid.addWidget(self.spin_sat, 2, 1)
        v.addLayout(grid)
        self.spin_exp.valueChanged.connect(self._retonemap)
        self.spin_comp.valueChanged.connect(self._retonemap)
        self.spin_sat.valueChanged.connect(self._retonemap)

        row = QHBoxLayout()
        btn_sample = QPushButton("生成演示样例…")
        btn_sample.clicked.connect(self._make_samples)
        btn_export = QPushButton("导出 PNG + JSON…")
        btn_export.clicked.connect(self._export)
        row.addWidget(btn_sample)
        row.addWidget(btn_export)
        v.addLayout(row)
        btn_zoom = QPushButton("缩放适应窗口")
        btn_zoom.clicked.connect(self._zoom_fit)
        v.addWidget(btn_zoom)

        self.info_label = QLabel("尚未加载照片")
        self.info_label.setWordWrap(True)
        v.addWidget(self.info_label)
        v.addWidget(QLabel("探针 (单击任一视图, 三视图同步显示十字线):"))
        self.probe_text = QTextEdit()
        self.probe_text.setReadOnly(True)
        self.probe_text.setFixedHeight(170)
        v.addWidget(self.probe_text)
        v.addStretch(1)
        return panel

    # ---------------- 照片管理 ----------------
    def _add_photos(self):
        paths, _ = QFileDialog.getOpenFileNames(
            self, "选择照片", "", "图片 (*.png *.jpg *.jpeg)")
        if paths:
            self._load_paths(paths, append=True)

    def _del_selected(self):
        row = self.list.currentRow()
        if 0 <= row < len(self.shots):
            del self.shots[row]
            self._after_shots_changed()

    def _load_paths(self, paths, evs=None, shifts=None, append=False):
        new_shots = []
        for p in paths:
            try:
                img = core.load_image(p)
            except ValueError as e:
                QMessageBox.warning(self, "跳过图片", str(e))
                continue
            new_shots.append(Shot(p, img))
        if not new_shots:
            return
        shots = (self.shots + new_shots) if append else new_shots
        if len(shots) > core.MAX_IMAGES:
            QMessageBox.warning(self, "超出上限",
                                f"最多 {core.MAX_IMAGES} 张照片")
            return
        sizes = {s.img.shape[:2] for s in shots}
        if len(sizes) > 1:
            QMessageBox.warning(self, "尺寸不一致", "所有照片尺寸必须一致")
            return
        self.shots = shots
        if evs:
            for s, ev in zip(self.shots, evs):
                s.ev = float(ev)
        if shifts:
            for s, sh in zip(self.shots, shifts):
                s.dx, s.dy = int(sh[0]), int(sh[1])
        self._after_shots_changed()
        self._zoom_fit()

    def _after_shots_changed(self):
        self._refresh_list()
        if self.shots:
            self.list.setCurrentRow(0)
        self._schedule_merge()
        self._refresh_reference_view()

    def _refresh_list(self):
        self._updating = True
        row = self.list.currentRow()
        self.list.clear()
        for i, s in enumerate(self.shots):
            self.list.addItem(
                f"{i + 1}. {s.name}  EV={s.ev:+g}  Δ({s.dx},{s.dy})")
        self._updating = False
        if 0 <= row < len(self.shots):
            self.list.setCurrentRow(row)

    def _on_select(self, row):
        if self._updating or not (0 <= row < len(self.shots)):
            return
        s = self.shots[row]
        for spin, val in ((self.spin_ev, s.ev), (self.spin_dx, s.dx),
                          (self.spin_dy, s.dy)):
            spin.blockSignals(True)
            spin.setValue(val)
            spin.blockSignals(False)
        self._refresh_reference_view()

    def _param_changed(self):
        row = self.list.currentRow()
        if self._updating or not (0 <= row < len(self.shots)):
            return
        s = self.shots[row]
        s.ev = self.spin_ev.value()
        s.dx = self.spin_dx.value()
        s.dy = self.spin_dy.value()
        self._refresh_list()
        self.list.setCurrentRow(row)
        self._schedule_merge()
        self._refresh_reference_view()

    # ---------------- 合成与调色 ----------------
    def _schedule_merge(self):
        self._merge_timer.start(150)

    def _remerge(self):
        if len(self.shots) < core.MIN_IMAGES:
            self.hdr = self.valid = self.crop = self.final_u8 = None
            self.view_hdr.set_pixmap("main", None)
            self.view_final.set_pixmap("main", None)
            self.view_ref.set_crop_rect(None)
            self.info_label.setText(
                f"至少需要 {core.MIN_IMAGES} 张照片才能合成 "
                f"(当前 {len(self.shots)} 张)")
            return
        try:
            self.hdr, self.valid, self.crop = core.merge_exposures(
                [s.img for s in self.shots],
                [s.ev for s in self.shots],
                [(s.dx, s.dy) for s in self.shots])
        except ValueError as e:
            self.hdr = self.valid = self.crop = self.final_u8 = None
            self.info_label.setText(f"合成失败: {e}")
            return
        x0, y0, x1, y1 = self.crop
        n_inv = int((~self.valid).sum())
        warn = ("\n⚠ 存在整组截断区域(品红), 细节无法恢复"
                if n_inv else "")
        self.info_label.setText(
            f"有效重叠区: x[{x0},{x1}) y[{y0},{y1})\n"
            f"导出尺寸: {x1 - x0}×{y1 - y0} 像素 (全分辨率, 与预览缩放无关)\n"
            f"无法恢复像素: {n_inv}{warn}")
        self.view_ref.set_crop_rect(self.crop)
        # 合成亮度视图 (log 灰度 + 品红无效区)
        lum = core.luminance(self.hdr)
        g = np.log10(np.maximum(lum, 1e-6))
        norm = np.clip((g + 4.0) / 5.0, 0, 1)
        disp = np.repeat((norm * 255).astype(np.uint8)[..., None], 3, axis=2)
        disp[~self.valid] = MAGENTA
        self.view_hdr.set_pixmap("main", disp, (x0, y0))
        self._retonemap()

    def _retonemap(self):
        if self.hdr is None:
            return
        tone = core.tone_map(self.hdr, self.spin_exp.value(),
                             self.spin_comp.value(), self.spin_sat.value())
        u8 = (tone * 255.0 + 0.5).astype(np.uint8)
        u8[~self.valid] = MAGENTA
        self.final_u8 = u8
        x0, y0, _, _ = self.crop
        self.view_final.set_pixmap("main", u8, (x0, y0))

    # ---------------- 参考/对齐视图 ----------------
    def _refresh_reference_view(self):
        row = self.list.currentRow()
        if not (0 <= row < len(self.shots)):
            self.view_ref.set_pixmap("sel", None)
            self.view_ref.set_pixmap("ref", None)
            return
        s = self.shots[row]
        disp = s.img
        if self.chk_clip.isChecked():
            disp = s.img.copy()
            lo, hi = core.clipping_masks(s.img)
            disp[lo] = (60, 120, 255)
            disp[hi] = (255, 60, 60)
        opacity = (self.slider_opacity.value() / 100.0
                   if self.chk_align.isChecked() else 1.0)
        self.view_ref.set_pixmap("sel", disp, (s.dx, s.dy), opacity)
        if self.chk_align.isChecked() and row != 0:
            r0 = self.shots[0]
            self.view_ref.set_pixmap("ref", r0.img, (r0.dx, r0.dy), 1.0)
        else:
            self.view_ref.set_pixmap("ref", None)

    # ---------------- 缩放/滚动同步 ----------------
    def _apply_zoom(self):
        for v in self._views:
            v.resetTransform()
            v.scale(self.zoom, self.zoom)

    def _zoom_by(self, factor):
        self.zoom = min(40.0, max(0.05, self.zoom * factor))
        self._apply_zoom()

    def _zoom_fit(self):
        if not self.shots:
            return
        w = self.shots[0].img.shape[1]
        vw = self.view_ref.viewport().width() or 400
        self.zoom = min(1.0, max(0.05, (vw - 20) / w))
        self._apply_zoom()

    def _sync_scroll(self, src, axis, val):
        if self._syncing_scroll:
            return
        self._syncing_scroll = True
        for v in self._views:
            if v is src:
                continue
            bar = (v.horizontalScrollBar() if axis == "h"
                   else v.verticalScrollBar())
            bar.setValue(val)
        self._syncing_scroll = False

    # ---------------- 探针 ----------------
    def _probe(self, x, y):
        xi, yi = int(round(x)), int(round(y))
        lines = [f"画布坐标: ({xi}, {yi})"]
        if not self.shots:
            self.probe_text.setPlainText("尚未加载照片")
            return
        h, w = self.shots[0].img.shape[:2]
        for i, s in enumerate(self.shots):
            sx, sy = xi - s.dx, yi - s.dy
            if 0 <= sx < w and 0 <= sy < h:
                r, g, b = (int(v) for v in s.img[sy, sx])
                tags = []
                if min(r, g, b) <= core.CLIP_LO:
                    tags.append("暗部截断")
                if max(r, g, b) >= core.CLIP_HI:
                    tags.append("亮部截断")
                lines.append(
                    f"图{i + 1} {s.name}: sRGB({r},{g},{b}) "
                    f"EV={s.ev:+g} {' '.join(tags)}")
            else:
                lines.append(
                    f"图{i + 1} {s.name}: 画面外 — 无效边缘, 不参与合成")
        if self.hdr is not None:
            x0, y0, x1, y1 = self.crop
            if x0 <= xi < x1 and y0 <= yi < y1:
                hx, hy = xi - x0, yi - y0
                if self.valid[hy, hx]:
                    lr, lg, lb = (float(v) for v in self.hdr[hy, hx])
                    lum = float(core.luminance(self.hdr[hy:hy + 1, hx:hx + 1])[0, 0])
                    lines.append(
                        f"合成线性亮度: ({lr:.5f}, {lg:.5f}, {lb:.5f}) "
                        f"亮度={lum:.5f}")
                else:
                    lines.append("合成: 整组截断 — 无法恢复")
                if self.final_u8 is not None:
                    fr, fg, fb = (int(v) for v in self.final_u8[hy, hx])
                    lines.append(
                        f"成品: sRGB({fr},{fg},{fb})  #{fr:02X}{fg:02X}{fb:02X}")
            else:
                lines.append("位于有效重叠区之外")
        self.probe_text.setPlainText("\n".join(lines))
        for v in self._views:
            v.cross.setPos(xi, yi)
            v.cross.setVisible(True)

    # ---------------- 样例与导出 ----------------
    def _make_samples(self):
        d = QFileDialog.getExistingDirectory(self, "选择样例输出目录")
        if not d:
            return
        meta = samples.generate(d)
        self._load_paths([str(Path(d) / f) for f in meta["files"]],
                         meta["evs"], meta["shifts"])
        QMessageBox.information(
            self, "样例已生成",
            "已生成 5 张带轻微位移的多曝光样例并载入。\n"
            "位移值已按 shots.json 自动填入, 可在列表中选中照片微调 dx/dy, "
            "勾选“半透明叠加参考图”检查对齐。")

    def _export(self):
        if self.final_u8 is None or self.crop is None:
            QMessageBox.warning(self, "无法导出", "请先完成合成")
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "导出 PNG", "hdr_result.png", "PNG 图片 (*.png)")
        if not path:
            return
        x0, y0, x1, y1 = self.crop
        meta = {
            "images": [{"file": s.name, "ev": s.ev, "shift": [s.dx, s.dy]}
                       for s in self.shots],
            "tone": {"exposure_stops": self.spin_exp.value(),
                     "compression": self.spin_comp.value(),
                     "saturation": self.spin_sat.value()},
            "crop_xyxy": [x0, y0, x1, y1],
            "size": [x1 - x0, y1 - y0],
            "invalid_pixels": int((~self.valid).sum()),
            "note": "PNG 为有效重叠区的全分辨率结果(与预览缩放无关); "
                    "品红(255,0,255)像素为整组截断、无法恢复区域",
        }
        out = core.write_export(path, self.final_u8, meta)
        self.info_label.setText(
            self.info_label.text() + f"\n已导出: {out}")


def main():
    app = QApplication(sys.argv)
    w = MainWindow()
    w.resize(1560, 920)
    w.show()
    sys.exit(app.exec())
