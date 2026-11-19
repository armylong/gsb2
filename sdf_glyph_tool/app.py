"""PySide6 界面: 参数面板 + 四视图对照 (参考轮廓 / 距离场 / 位图缩放 / SDF 重建)。

四个视图共用 render.py 的坐标映射, 切换显示方式、改倍率或平移时位置与基线一致。
"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, QPointF
from PySide6.QtGui import (QImage, QPainter, QPainterPath, QPen, QColor,
                           QMouseEvent)
from PySide6.QtWidgets import (QApplication, QMainWindow, QWidget, QComboBox,
                               QDoubleSpinBox, QCheckBox, QPushButton, QLabel,
                               QFormLayout, QHBoxLayout, QGridLayout,
                               QVBoxLayout, QFileDialog, QMessageBox,
                               QGroupBox, QScrollArea)

from .geometry import GLYPHS, get_glyph
from .sdf import (compute_sdf, clamp_sdf, rasterize_bitmap, glyph_to_source,
                  zero_crossing_segments, sample_sdf)
from .render import (RenderParams, canvas_size, render_bitmap,
                     render_sdf_coverage, compose_rgba, sdf_colormap)
from . import exporter

VIEW_MODES = ("reference", "sdf", "bitmap", "recon")
VIEW_TITLES = {"reference": "参考轮廓 + 源位图",
               "sdf": "距离场 (颜色=距离, 绿线=零轮廓)",
               "bitmap": "普通位图缩放",
               "recon": "SDF 重建 (+参考轮廓)"}


class State:
    """共享状态: 源字形、距离场、渲染参数、探针。"""

    def __init__(self):
        self.glyph = GLYPHS[0]
        self.n = 128
        self.value_range = 4.0
        self.params = RenderParams()
        self.show_reference = True
        self.probe: tuple[float, float] | None = None  # 源连续坐标 (u, v)
        self.rebuild_source()

    def rebuild_source(self):
        """字形 / 源尺寸 / 存储范围变化时重建。"""
        self.contours_src = glyph_to_source(self.glyph.contours, self.n)
        sdf = compute_sdf(self.contours_src, self.n)
        self.sdf = clamp_sdf(sdf, self.value_range)
        self.bitmap = rasterize_bitmap(self.contours_src, self.n)
        self.zero_segs = zero_crossing_segments(self.sdf)

    @property
    def canvas(self) -> int:
        return canvas_size(self.n, self.params.scale)


class CanvasView(QWidget):
    def __init__(self, state: State, mode: str):
        super().__init__()
        self.state = state
        self.mode = mode
        self.setMinimumSize(340, 340)
        self.setMouseTracking(True)
        self._img = None  # 保持 QImage 底层缓冲存活

    # ---- 坐标换算 ----
    def _canvas_offset(self):
        return ((self.state.canvas - self.width()) / 2.0,
                (self.state.canvas - self.height()) / 2.0)

    def _sdf_fit(self):
        n = self.state.n
        k = min(self.width(), self.height()) / n
        return k, ((self.width() - n * k) / 2.0, (self.height() - n * k) / 2.0)

    def view_to_source(self, pos: QPointF) -> tuple[float, float]:
        p = self.state.params
        if self.mode == "sdf":
            k, (ox, oy) = self._sdf_fit()
            return (pos.x() - ox) / k, (pos.y() - oy) / k
        offx, offy = self._canvas_offset()
        u = (pos.x() + offx + 0.5) / p.scale - p.tx
        v = (pos.y() + offy + 0.5) / p.scale - p.ty
        return u, v

    # ---- 事件 ----
    def mouseMoveEvent(self, e: QMouseEvent):
        self.state.probe = self.view_to_source(e.position())
        self.window().probe_changed()

    def leaveEvent(self, e):
        self.state.probe = None
        self.window().probe_changed()

    # ---- 绘制 ----
    def paintEvent(self, e):
        qp = QPainter(self)
        qp.fillRect(self.rect(), QColor(32, 32, 36))
        getattr(self, f"_draw_{self.mode}")(qp)
        self._draw_probe(qp)
        qp.end()

    def _canvas_transform(self, qp: QPainter):
        """让源坐标可以直接画到画布视图 (含平移与视口裁剪偏移)。"""
        p = self.state.params
        offx, offy = self._canvas_offset()
        qp.translate(-offx, -offy)
        qp.scale(p.scale, p.scale)
        qp.translate(p.tx, p.ty)

    def _reference_path(self) -> QPainterPath:
        path = QPainterPath()
        for c in self.state.contours_src:
            path.moveTo(c[0, 0], c[0, 1])
            for pt in c[1:]:
                path.lineTo(pt[0], pt[1])
            path.closeSubpath()
        return path

    def _draw_reference(self, qp: QPainter):
        st = self.state
        qp.save()
        self._canvas_transform(qp)
        # 源位图(最近邻, 能看到像素网格)
        bmp = (st.bitmap * 255).astype(np.uint8)
        img = QImage(bmp.data, st.n, st.n, st.n, QImage.Format.Format_Grayscale8).copy()
        qp.drawImage(QPointF(0.0, 0.0), img)
        # 高精度参考轮廓
        pen = QPen(QColor(80, 255, 120))
        pen.setWidthF(0)
        pen.setCosmetic(True)
        qp.setPen(pen)
        qp.setBrush(Qt.BrushStyle.NoBrush)
        qp.drawPath(self._reference_path())
        qp.restore()

    def _draw_sdf(self, qp: QPainter):
        st = self.state
        k, (ox, oy) = self._sdf_fit()
        rgb = sdf_colormap(st.sdf, st.value_range)
        img = QImage(rgb.data, st.n, st.n, 3 * st.n,
                     QImage.Format.Format_RGB888).copy()
        qp.drawImage(QPointF(ox, oy),
                     img.scaled(int(st.n * k), int(st.n * k)))
        pen = QPen(QColor(60, 255, 90))
        pen.setWidthF(1.2)
        qp.setPen(pen)
        for (x0, y0), (x1, y1) in st.zero_segs:
            qp.drawLine(QPointF(ox + x0 * k, oy + y0 * k),
                        QPointF(ox + x1 * k, oy + y1 * k))

    def _draw_bitmap(self, qp: QPainter):
        st = self.state
        p = st.params
        offx, offy = self._canvas_offset()
        xs = np.arange(self.width()) + offx
        ys = np.arange(self.height()) + offy
        cov = render_bitmap(st.bitmap, xs, ys, p)
        rgba = np.zeros((len(ys), len(xs), 4), dtype=np.uint8)
        rgba[..., :3] = 255
        rgba[..., 3] = np.clip(cov * 255 + 0.5, 0, 255).astype(np.uint8)
        self._blit(qp, rgba)

    def _draw_recon(self, qp: QPainter):
        st = self.state
        p = st.params
        offx, offy = self._canvas_offset()
        xs = np.arange(self.width()) + offx
        ys = np.arange(self.height()) + offy
        fill, band = render_sdf_coverage(st.sdf, xs, ys, p)
        self._blit(qp, compose_rgba(fill, band))
        if st.show_reference:
            qp.save()
            self._canvas_transform(qp)
            pen = QPen(QColor(80, 255, 120, 200))
            pen.setWidthF(0)
            pen.setCosmetic(True)
            qp.setPen(pen)
            qp.setBrush(Qt.BrushStyle.NoBrush)
            qp.drawPath(self._reference_path())
            qp.restore()

    def _blit(self, qp: QPainter, rgba: np.ndarray):
        h, w = rgba.shape[:2]
        buf = np.ascontiguousarray(rgba)
        self._img = QImage(buf.data, w, h, 4 * w, QImage.Format.Format_RGBA8888).copy()
        qp.drawImage(0, 0, self._img)

    def _draw_probe(self, qp: QPainter):
        st = self.state
        if st.probe is None:
            return
        u, v = st.probe
        if self.mode == "sdf":
            k, (ox, oy) = self._sdf_fit()
            x, y = ox + u * k, oy + v * k
        else:
            p = st.params
            offx, offy = self._canvas_offset()
            x = (u + p.tx) * p.scale - offx
            y = (v + p.ty) * p.scale - offy
        pen = QPen(QColor(255, 220, 0))
        pen.setWidthF(1.0)
        qp.setPen(pen)
        qp.drawLine(QPointF(x - 7, y), QPointF(x + 7, y))
        qp.drawLine(QPointF(x, y - 7), QPointF(x, y + 7))


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("SDF 字形观察工具")
        self.state = State()
        self.views = {m: CanvasView(self.state, m) for m in VIEW_MODES}
        self._build_ui()
        self.refresh_all()

    # ---------- UI ----------
    def _build_ui(self):
        central = QWidget()
        root = QHBoxLayout(central)
        root.addWidget(self._build_panel())
        grid = QGridLayout()
        for i, mode in enumerate(VIEW_MODES):
            box = QGroupBox(VIEW_TITLES[mode])
            lay = QVBoxLayout(box)
            lay.addWidget(self.views[mode])
            grid.addWidget(box, i // 2, i % 2)
        root.addLayout(grid, stretch=1)
        self.setCentralWidget(central)

    def _spin(self, lo, hi, step, val, cb):
        s = QDoubleSpinBox()
        s.setRange(lo, hi)
        s.setSingleStep(step)
        s.setDecimals(3)
        s.setValue(val)
        s.valueChanged.connect(cb)
        return s

    def _build_panel(self) -> QWidget:
        panel = QWidget()
        form = QFormLayout(panel)

        self.glyph_combo = QComboBox()
        for g in GLYPHS:
            self.glyph_combo.addItem(g.name)
        self.glyph_combo.currentTextChanged.connect(self._glyph_changed)
        form.addRow("字形", self.glyph_combo)

        self.size_combo = QComboBox()
        for n in (64, 128, 256):
            self.size_combo.addItem(str(n))
        self.size_combo.setCurrentText(str(self.state.n))
        self.size_combo.currentTextChanged.connect(self._size_changed)
        form.addRow("源尺寸", self.size_combo)

        self.range_spin = self._spin(0.5, 32.0, 0.5, self.state.value_range,
                                     self._range_changed)
        form.addRow("存储距离范围 (源px)", self.range_spin)

        self.scale_spin = self._spin(0.5, 8.0, 0.1, self.state.params.scale,
                                     self._param_changed)
        form.addRow("放大倍率", self.scale_spin)
        self.tx_spin = self._spin(-4.0, 4.0, 0.05, 0.0, self._param_changed)
        form.addRow("平移 tx (源px)", self.tx_spin)
        self.ty_spin = self._spin(-4.0, 4.0, 0.05, 0.0, self._param_changed)
        form.addRow("平移 ty (源px)", self.ty_spin)
        self.thr_spin = self._spin(-8.0, 8.0, 0.1, 0.0, self._param_changed)
        form.addRow("轮廓阈值 (源px)", self.thr_spin)
        self.soft_spin = self._spin(0.0, 16.0, 0.25, 1.0, self._param_changed)
        form.addRow("柔边宽度 (显示px)", self.soft_spin)
        self.outline_spin = self._spin(0.0, 32.0, 0.5, 0.0, self._param_changed)
        form.addRow("描边宽度 (显示px)", self.outline_spin)

        self.ref_check = QCheckBox("重建视图叠加参考轮廓")
        self.ref_check.setChecked(True)
        self.ref_check.toggled.connect(self._param_changed)
        form.addRow(self.ref_check)

        self.info_label = QLabel("")
        self.info_label.setWordWrap(True)
        form.addRow(self.info_label)
        self.probe_label = QLabel("探针: 移动鼠标到任意视图")
        self.probe_label.setWordWrap(True)
        self.probe_label.setTextInteractionFlags(
            Qt.TextInteractionFlag.TextSelectableByMouse)
        form.addRow(self.probe_label)

        export_btn = QPushButton("导出 PNG + SDF + 参数")
        export_btn.clicked.connect(self.export_current)
        form.addRow(export_btn)
        load_btn = QPushButton("载入 SDF (.npy)")
        load_btn.clicked.connect(self.load_sdf)
        form.addRow(load_btn)

        scroll = QScrollArea()
        scroll.setWidget(panel)
        scroll.setWidgetResizable(True)
        scroll.setMinimumWidth(300)
        scroll.setMaximumWidth(340)
        return scroll

    # ---------- 状态更新 ----------
    def _glyph_changed(self, name):
        self.state.glyph = get_glyph(name)
        self.state.rebuild_source()
        self.refresh_all()

    def _size_changed(self, text):
        self.state.n = int(text)
        self.state.rebuild_source()
        self.refresh_all()

    def _range_changed(self, val):
        self.state.value_range = float(val)
        self.state.rebuild_source()
        self.refresh_all()

    def _param_changed(self, *_):
        p = self.state.params
        p.scale = self.scale_spin.value()
        p.tx = self.tx_spin.value()
        p.ty = self.ty_spin.value()
        p.threshold = self.thr_spin.value()
        p.softness_px = self.soft_spin.value()
        p.outline_px = self.outline_spin.value()
        self.state.show_reference = self.ref_check.isChecked()
        self.refresh_all()

    def refresh_all(self):
        st = self.state
        self.info_label.setText(
            f"{st.glyph.desc}\n"
            f"源 {st.n}×{st.n}, 导出/预览画布 {st.canvas}×{st.canvas} 显示px")
        for v in self.views.values():
            v.update()
        self.probe_changed()

    def probe_changed(self):
        st = self.state
        if st.probe is None:
            self.probe_label.setText("探针: 移动鼠标到任意视图")
        else:
            u, v = st.probe
            p = st.params
            d = float(sample_sdf(st.sdf, np.array([u]), np.array([v]))[0])
            soft_src = p.softness_px / p.scale
            if soft_src <= 1e-9:
                fill = 1.0 if d >= p.threshold else 0.0
            else:
                fill = float(np.clip((d - p.threshold) / soft_src + 0.5, 0, 1))
            if p.outline_px > 0:
                half_src = 0.5 * p.outline_px / p.scale
                band_arg = half_src - abs(d - p.threshold)
                band = 1.0 if soft_src <= 1e-9 else float(
                    np.clip(band_arg / soft_src + 0.5, 0, 1))
            else:
                band = 0.0
            self.probe_label.setText(
                f"源坐标 u={u:.3f} v={v:.3f} (源px)\n"
                f"距离 d={d:+.3f} 源px ({'内' if d >= 0 else '外'})\n"
                f"覆盖率 填充={fill:.3f} 描边={band:.3f} 合成={max(fill, band):.3f}")
        for v in self.views.values():
            v.update()

    # ---------- 导出 / 载入 ----------
    def export_current(self):
        path, _ = QFileDialog.getSaveFileName(
            self, "导出透明 PNG", "glyph_export.png", "PNG (*.png)")
        if not path:
            return
        if not path.lower().endswith(".png"):
            path += ".png"
        st = self.state
        p = st.params
        d = st.canvas
        xs, ys = np.arange(d), np.arange(d)
        fill, band = render_sdf_coverage(st.sdf, xs, ys, p)
        rgba = compose_rgba(fill, band)
        try:
            exporter.save_png_rgba(path, rgba)
            base = path[:-4]
            params = {
                "glyph": st.glyph.name,
                "source_size": st.n,
                "value_range_src_px": st.value_range,
                "render": p.to_dict(),
                "export_size_px": [d, d],
                "glyph_placement": "字形 em 方框位于源图中央 80% 区域, y 翻转; "
                                   "导出像素 p 对应源坐标 (p+0.5)/scale - t",
                "sdf_convention": "内部为正, 外部为负, 单位源图像素, "
                                  "超出存储范围已截断",
            }
            files = exporter.save_sdf_bundle(base, st.sdf, params)
            QMessageBox.information(
                self, "导出完成",
                f"PNG: {path}\nSDF: {files['npy']}\n参数: {files['json']}\n"
                f"尺寸 {d}×{d} 显示px, 与预览一致")
        except Exception as ex:  # noqa: BLE001
            QMessageBox.critical(self, "导出失败", str(ex))

    def load_sdf(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "载入 SDF", "", "SDF (*.npy)")
        if not path:
            return
        try:
            sdf, params = exporter.load_sdf_bundle(path)
        except Exception as ex:  # noqa: BLE001
            QMessageBox.critical(self, "载入失败", str(ex))
            return
        st = self.state
        st.n = int(sdf.shape[0])
        st.sdf = sdf
        st.zero_segs = zero_crossing_segments(sdf)
        glyph_name = params.get("glyph")
        if glyph_name:
            try:
                st.glyph = get_glyph(glyph_name)
                self.glyph_combo.setCurrentText(glyph_name)
            except KeyError:
                pass
        st.value_range = float(params.get("value_range_src_px", st.value_range))
        st.contours_src = glyph_to_source(st.glyph.contours, st.n)
        st.bitmap = rasterize_bitmap(st.contours_src, st.n)
        rp = params.get("render", {})
        for k in ("scale", "tx", "ty", "threshold", "softness_px", "outline_px"):
            if k in rp:
                setattr(st.params, k, float(rp[k]))
        # 同步控件 (阻塞信号避免重复刷新)
        for w, val in ((self.size_combo, str(st.n)),
                       (self.range_spin, st.value_range),
                       (self.scale_spin, st.params.scale),
                       (self.tx_spin, st.params.tx),
                       (self.ty_spin, st.params.ty),
                       (self.thr_spin, st.params.threshold),
                       (self.soft_spin, st.params.softness_px),
                       (self.outline_spin, st.params.outline_px)):
            w.blockSignals(True)
            w.setValue(val) if hasattr(w, "setValue") else w.setCurrentText(val)
            w.blockSignals(False)
        self.refresh_all()


def main():
    import sys
    app = QApplication(sys.argv)
    win = MainWindow()
    win.resize(1280, 860)
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
