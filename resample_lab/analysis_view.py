"""Analysis view: four side-by-side filtered crops + per-region diagnostics.

Everything the user changes (sample, scale, integer/fractional offset,
premultiply, filter selection) triggers a recompute of the same crop across
the filters, so the numbers below the previews are directly comparable.

The picture area draws each output at an integer zoom factor with
nearest-neighbour sampling, over a grey checkerboard so transparency is
visible.  An optional overlay draws the output pixel boundaries.
"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QRect, Qt, Signal
from PySide6.QtGui import QColor, QFont, QImage, QPainter, QPen
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFormLayout,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from . import core, samples
from .plot import LinePlot


# --------------------------------------------------------------------------- #
# Preview widget
# --------------------------------------------------------------------------- #
class ImageView(QWidget):
    """Draws an RGBA numpy image at an integer zoom over a checkerboard."""

    clicked = Signal(int, int)  # output coordinates (col, row)

    def __init__(self, title: str = "", parent=None):
        super().__init__(parent)
        self._image: np.ndarray | None = None
        self._qimage: QImage | None = None
        self._title = title
        self._zoom = 1
        self._zoom_cap: int | None = None
        self._auto_fit = True
        self._hover: tuple[int, int] | None = None
        self._mark: tuple[int, int] | None = None
        self._show_grid = True
        self.setMinimumSize(120, 120)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setMouseTracking(True)

    # -- data ------------------------------------------------------------- #
    def set_image(self, rgba: np.ndarray | None) -> None:
        self._image = rgba
        self._qimage = core.to_qimage(rgba) if rgba is not None else None
        self.update()

    def set_zoom(self, zoom: int) -> None:
        self._zoom = max(1, int(zoom))
        self.update()

    def set_zoom_cap(self, cap: int | None) -> None:
        """Upper bound for auto-fit (keeps a 48x48 result from filling 600 px)."""
        self._zoom_cap = cap
        self.update()

    def set_auto_fit(self, enabled: bool) -> None:
        self._auto_fit = bool(enabled)
        self.update()

    def set_mark(self, mark: tuple[int, int] | None) -> None:
        self._mark = mark
        self.update()

    def set_show_grid(self, enabled: bool) -> None:
        self._show_grid = enabled
        self.update()

    def image(self) -> np.ndarray | None:
        return self._image

    # -- geometry --------------------------------------------------------- #
    def _effective_zoom(self) -> int:
        if self._qimage is None:
            return 1
        if not self._auto_fit:
            return self._zoom
        margin = 28
        fw = max(1, (self.width() - margin) // self._qimage.width())
        fh = max(1, (self.height() - margin) // self._qimage.height())
        cap = self._zoom_cap if self._zoom_cap is not None else 64
        return max(1, min(fw, fh, cap))

    def _target_rect(self):
        if self._qimage is None:
            return None
        zoom = self._effective_zoom()
        w = self._qimage.width() * zoom
        h = self._qimage.height() * zoom
        x = (self.width() - w) // 2
        y = (self.height() - h) // 2
        return x, y, w, h

    def _map_from_widget(self, pos) -> tuple[int, int] | None:
        rect = self._target_rect()
        if rect is None:
            return None
        x, y, w, h = rect
        px, py = pos.x() - x, pos.y() - y
        if not (0 <= px < w and 0 <= py < h):
            return None
        zoom = self._effective_zoom()
        return px // zoom, py // zoom

    # -- painting --------------------------------------------------------- #
    def paintEvent(self, event) -> None:  # noqa: N802 (Qt API)
        p = QPainter(self)
        try:
            self._paint(p)
        finally:
            p.end()

    def _paint(self, p: QPainter) -> None:
        p.fillRect(self.rect(), QColor(28, 30, 34))
        rect = self._target_rect()
        if rect is None or self._qimage is None:
            p.setPen(QColor(150, 150, 150))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "无预览")
            return
        x, y, w, h = rect
        self._paint_checkerboard(p, x, y, w, h)

        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, False)
        p.drawImage(QRect(x, y, w, h), self._qimage)

        nw, nh = self._qimage.width(), self._qimage.height()
        zoom = self._effective_zoom()
        if self._show_grid and zoom >= 4 and nw * nh <= 200 * 200:
            pen = QPen(QColor(255, 255, 255, 40))
            pen.setWidth(1)
            p.setPen(pen)
            for i in range(1, nw):
                p.drawLine(x + i * zoom, y, x + i * zoom, y + h)
            for j in range(1, nh):
                p.drawLine(x, y + j * zoom, x + w, y + j * zoom)

        p.setPen(QPen(QColor(255, 255, 255, 60)))
        p.drawRect(x, y, w - 1, h - 1)

        for coord, colour, width in ((self._mark, QColor(255, 170, 0), 2),
                                     (self._hover, QColor(0, 220, 255), 2)):
            if coord is None:
                continue
            cx, cy = coord
            if not (0 <= cx < nw and 0 <= cy < nh):
                continue
            pen = QPen(colour)
            pen.setWidth(width)
            p.setPen(pen)
            p.drawRect(
                x + cx * zoom,
                y + cy * zoom,
                zoom,
                zoom,
            )

        if self._title:
            p.setPen(QColor(230, 230, 230))
            font = QFont()
            font.setBold(True)
            p.setFont(font)
            p.drawText(x + 6, y + 16, self._title)
            p.setFont(QFont())

        size = self._qimage.size()
        p.setPen(QColor(160, 200, 160))
        p.drawText(x, y + h + 16, f"{size.width()}×{size.height()} px · {zoom}×")

    def _paint_checkerboard(self, p: QPainter, x: int, y: int, w: int, h: int) -> None:
        cell = 8
        p.save()
        p.setClipRect(x, y, w, h)
        for j in range(0, h, cell):
            for i in range(0, w, cell):
                shade = 60 if ((i // cell) + (j // cell)) % 2 == 0 else 80
                p.fillRect(x + i, y + j, cell, cell, QColor(shade, shade, shade))
        p.restore()

    # -- interaction ------------------------------------------------------- #
    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        coord = self._map_from_widget(event.position().toPoint())
        if coord != self._hover:
            self._hover = coord
            self.update()

    def leaveEvent(self, event) -> None:  # noqa: N802
        self._hover = None
        self.update()

    def mousePressEvent(self, event) -> None:  # noqa: N802
        coord = self._map_from_widget(event.position().toPoint())
        if coord is not None:
            self.clicked.emit(*coord)


# --------------------------------------------------------------------------- #
# Root tab
# --------------------------------------------------------------------------- #
METRIC_FIELDS = [
    ("mean_alpha", "平均透明度 α"),
    ("peak_alpha", "峰值 α"),
    ("colour_luma", "可见色亮度(α加权)"),
    ("composite_luma", "黑底合成亮度"),
    ("interior_luma", "实心区亮度"),
    ("edge_luma", "半透明边缘亮度"),
    ("edge_delta", "边缘-实心 (负=变黑)"),
    ("fringe_luma", "可见像素亮度"),
    ("fringe_delta", "可见-加权 (负=偏暗)"),
    ("min_visible_luma", "最暗可见像素"),
    ("visible_pixels", "可见像素数"),
]


class AnalysisTab(QWidget):
    status = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._image: np.ndarray | None = None
        self._image_key: str | None = None
        self._sample_key = samples.SAMPLE_ORDER[0]
        self._results: dict[str, core.Result] = {}

        root = QHBoxLayout(self)
        root.setContentsMargins(8, 8, 8, 8)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setWidget(self._build_controls())
        scroll.setMinimumWidth(320)
        scroll.setMaximumWidth(340)
        scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        root.addWidget(scroll, 0)

        right = QVBoxLayout()
        self.views: dict[str, ImageView] = {}
        grid = QGridLayout()
        grid.setSpacing(6)
        for idx, key in enumerate(core.FILTER_ORDER):
            view = ImageView(core.FILTERS[key].short)
            view.clicked.connect(self._on_pixel_clicked)
            self.views[key] = view
            grid.addWidget(view, idx // 2, idx % 2)
        right.addLayout(grid, 1)

        table_scroll = QScrollArea()
        table_scroll.setWidgetResizable(True)
        table_scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        table_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        table_scroll.setMinimumHeight(250)
        table_scroll.setMaximumHeight(390)
        self.metrics_table = self._build_metrics_table()
        table_scroll.setWidget(self.metrics_table)
        right.addWidget(table_scroll, 1)

        self.plot = LinePlot()
        self.plot.setMinimumHeight(170)
        right.addWidget(self.plot, 0)
        root.addLayout(right, 1)

        self._recompute()

    # -- construction ------------------------------------------------------ #
    def _build_controls(self) -> QWidget:
        box = QWidget()
        box.setFixedWidth(300)
        outer = QVBoxLayout(box)
        outer.setContentsMargins(0, 0, 0, 0)

        sample_box = QGroupBox("样例 / 原采样网格")
        form = QFormLayout(sample_box)
        self.sample_combo = QComboBox()
        for key in samples.SAMPLE_ORDER:
            self.sample_combo.addItem(samples.SAMPLES[key][0], key)
        self.sample_combo.currentIndexChanged.connect(self._on_sample_changed)
        form.addRow("样例", self.sample_combo)

        self.source_size = QSpinBox()
        self.source_size.setRange(16, 1024)
        self.source_size.setSingleStep(16)
        self.source_size.setValue(256)
        self.source_size.valueChanged.connect(self._recompute)
        form.addRow("原图边长 (px)", self.source_size)

        self.crop_size = QSpinBox()
        self.crop_size.setRange(2, 1024)
        self.crop_size.setValue(192)
        self.crop_size.valueChanged.connect(self._recompute)
        form.addRow("裁剪边长 (px)", self.crop_size)

        self.offset_x = QDoubleSpinBox()
        self.offset_x.setRange(-400.0, 400.0)
        self.offset_x.setDecimals(3)
        self.offset_x.setSingleStep(0.25)
        self.offset_x.valueChanged.connect(self._recompute)
        form.addRow("横向偏移 X (px)", self.offset_x)

        self.offset_y = QDoubleSpinBox()
        self.offset_y.setRange(-400.0, 400.0)
        self.offset_y.setDecimals(3)
        self.offset_y.setSingleStep(0.25)
        self.offset_y.valueChanged.connect(self._recompute)
        form.addRow("纵向偏移 Y (px)", self.offset_y)
        outer.addWidget(sample_box)

        zoom_box = QGroupBox("缩放 / 显示")
        zform = QFormLayout(zoom_box)
        self.scale = QDoubleSpinBox()
        self.scale.setRange(0.0005, 8.0)
        self.scale.setDecimals(5)
        self.scale.setSingleStep(0.05)
        self.scale.setValue(0.25)
        self.scale.valueChanged.connect(self._recompute)
        zform.addRow("缩放比", self.scale)

        self.zoom = QSpinBox()
        self.zoom.setRange(1, 64)
        self.zoom.setValue(8)
        self.zoom.valueChanged.connect(self._on_zoom_changed)
        zform.addRow("预览放大 (不自动适配)", self.zoom)

        self.auto_fit = QCheckBox("自动适配预览窗口")
        self.auto_fit.setChecked(True)
        self.auto_fit.toggled.connect(self._on_zoom_changed)
        zform.addRow("", self.auto_fit)

        self.zoom_cap = QSpinBox()
        self.zoom_cap.setRange(1, 64)
        self.zoom_cap.setValue(12)
        self.zoom_cap.valueChanged.connect(self._on_zoom_changed)
        zform.addRow("自动适配上限", self.zoom_cap)

        self.premultiply = QCheckBox("预乘 α 后再滤波")
        self.premultiply.setChecked(True)
        self.premultiply.toggled.connect(self._recompute)
        zform.addRow("", self.premultiply)

        self.show_grid = QCheckBox("显示输出像素格")
        self.show_grid.setChecked(True)
        self.show_grid.toggled.connect(self._on_grid_toggled)
        zform.addRow("", self.show_grid)

        self.area_1x1 = QPushButton("压到 1×1 看整区平均")
        self.area_1x1.clicked.connect(self._set_one_by_one)
        zform.addRow(self.area_1x1)
        outer.addWidget(zoom_box)

        diag_box = QGroupBox("诊断")
        dform = QFormLayout(diag_box)
        self.mode = QComboBox()
        self.mode.addItem("随缩放比 (扫 scale)", "scale")
        self.mode.addItem("随横向偏移 (扫 X)", "offset_x")
        self.mode.addItem("随纵向偏移 (扫 Y)", "offset_y")
        self.mode.currentIndexChanged.connect(self._recompute)
        dform.addRow("曲线模式", self.mode)

        self.sweep_steps = QSpinBox()
        self.sweep_steps.setRange(8, 400)
        self.sweep_steps.setValue(64)
        self.sweep_steps.valueChanged.connect(self._recompute)
        dform.addRow("扫描步数", self.sweep_steps)

        self.plot_metric = QComboBox()
        for key, label in METRIC_FIELDS:
            if key != "visible_pixels":
                self.plot_metric.addItem(label, key)
        self.plot_metric.currentIndexChanged.connect(self._recompute)
        dform.addRow("曲线指标", self.plot_metric)

        self.export_button = QPushButton("导出当前结果…")
        self.export_button.clicked.connect(self._on_export)
        dform.addRow(self.export_button)
        outer.addWidget(diag_box)

        self.info = QLabel()
        self.info.setWordWrap(True)
        self.info.setStyleSheet("color:#9ab; font-size: 11px;")
        outer.addWidget(self.info)
        outer.addStretch(1)
        return box

    def _build_metrics_table(self) -> QWidget:
        box = QGroupBox("同一区域的平均亮度 / 透明度")
        box.setStyleSheet(
            "QGroupBox { background:#1c1f24; color:#c8d2dc; border:1px solid #333; }"
            "QGroupBox::title { subcontrol-origin: margin; left:8px; padding:0 4px; }"
        )
        grid = QGridLayout(box)
        grid.setHorizontalSpacing(6)
        font = QFont("Menlo")
        font.setPointSize(10)
        self._metric_labels: dict[tuple[str, str], QLabel] = {}
        headers = ["指标"] + [core.FILTERS[k].short for k in core.FILTER_ORDER]
        for col, text in enumerate(headers):
            lab = QLabel(text)
            lab.setFont(font)
            lab.setStyleSheet("color:#9fb4c8;" + (" font-weight:bold;" if col == 0 else ""))
            lab.setFixedWidth(196 if col == 0 else 92)
            lab.setAlignment(
                Qt.AlignmentFlag.AlignLeft
                if col == 0
                else Qt.AlignmentFlag.AlignRight
            )
            grid.addWidget(lab, 0, col)
        for row, (key, label) in enumerate(METRIC_FIELDS, start=1):
            name = QLabel(label)
            name.setFont(font)
            name.setStyleSheet("color:#c8d2dc;")
            name.setFixedWidth(196)
            grid.addWidget(name, row, 0)
            for col, fkey in enumerate(core.FILTER_ORDER, start=1):
                value = QLabel("—")
                value.setFont(font)
                value.setFixedWidth(92)
                value.setAlignment(Qt.AlignmentFlag.AlignRight)
                self._metric_labels[(key, fkey)] = value
                grid.addWidget(value, row, col)
        grid.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
        return box

    # -- state ------------------------------------------------------------- #
    def current_image(self) -> np.ndarray | None:
        return self._image

    def sample_key(self) -> str:
        return self._sample_key

    def current_crop(self) -> core.Crop:
        size = (self.source_size.value(), self.source_size.value())
        crop_size = (self.crop_size.value(), self.crop_size.value())
        crop, _, _ = core.placed_crop(
            size, crop_size, self.offset_x.value(), self.offset_y.value()
        )
        return crop

    def current_out_size(self) -> tuple[int, int]:
        return core.output_size(self.current_crop(), self.scale.value())

    def set_controls(
        self,
        *,
        sample: str | None = None,
        source_size: int | None = None,
        crop_size: int | None = None,
        scale: float | None = None,
        offset_x: float | None = None,
        offset_y: float | None = None,
        premultiply: bool | None = None,
        zoom: int | None = None,
    ) -> None:
        """Programmatic control entry point (used by the verification command)."""
        widgets = []
        if sample is not None:
            idx = samples.SAMPLE_ORDER.index(sample)
            if idx != self.sample_combo.currentIndex():
                self.sample_combo.setCurrentIndex(idx)
                widgets.append(self.sample_combo)
        for widget, value in (
            (self.source_size, source_size),
            (self.crop_size, crop_size),
            (self.zoom, zoom),
        ):
            if value is not None and widget.value() != value:
                widget.setValue(value)
        for widget, value in (
            (self.scale, scale),
            (self.offset_x, offset_x),
            (self.offset_y, offset_y),
        ):
            if value is not None and abs(widget.value() - value) > 1e-9:
                widget.setValue(value)
        if premultiply is not None and self.premultiply.isChecked() != premultiply:
            self.premultiply.setChecked(premultiply)
        self._recompute()

    # -- slots ------------------------------------------------------------- #
    def _on_sample_changed(self) -> None:
        self._sample_key = self.sample_combo.currentData()
        self._recompute()

    def _on_zoom_changed(self) -> None:
        for view in self.views.values():
            view.set_zoom(self.zoom.value())
            view.set_zoom_cap(self.zoom_cap.value())
            view.set_auto_fit(self.auto_fit.isChecked())

    def _on_grid_toggled(self) -> None:
        for view in self.views.values():
            view.set_show_grid(self.show_grid.isChecked())

    def _set_one_by_one(self) -> None:
        crop = self.current_crop()
        shortest = max(1.0, min(crop.width, crop.height))
        self.scale.setValue(1.0 / shortest)

    def _on_pixel_clicked(self, x: int, y: int) -> None:
        for view in self.views.values():
            view.set_mark((x, y))
        self._update_pixel_readout(x, y)

    # -- recompute --------------------------------------------------------- #
    def _recompute(self) -> None:
        size = self.source_size.value()
        if (
            self._image is None
            or self._image.shape[0] != size
            or self._image_key != self._sample_key
        ):
            self._image = samples.make_sample(self._sample_key, size)
            self._image_key = self._sample_key

        crop = self.current_crop()
        out = self.current_out_size()
        premul = self.premultiply.isChecked()

        self._results = core.resample_all(self._image, crop, out, premul)
        zoom = self.zoom.value()
        for key, view in self.views.items():
            view.set_zoom(zoom)
            view.set_zoom_cap(self.zoom_cap.value())
            view.set_auto_fit(self.auto_fit.isChecked())
            view.set_show_grid(self.show_grid.isChecked())
            view.set_image(self._results[key].rgba)

        for key, label in METRIC_FIELDS:
            for fkey in core.FILTER_ORDER:
                metrics = self._results[fkey].metrics
                value = getattr(metrics, key)
                widget = self._metric_labels[(key, fkey)]
                if isinstance(value, float):
                    if np.isnan(value):
                        text = "—"
                    elif key.endswith("pixels"):
                        text = f"{int(value)}"
                    else:
                        text = f"{value:.4f}"
                else:
                    text = str(value)
                widget.setText(text)
                dark = (
                    key in ("edge_delta", "fringe_delta")
                    and isinstance(value, float)
                    and value < -0.05
                )
                widget.setStyleSheet("color:#ff8a7a;" if dark else "color:#e4ecf4;")

        self._update_info(crop, out)
        self._update_plot()
        self.status.emit(
            f"{samples.SAMPLES[self._sample_key][0]} · 输出 {out[0]}×{out[1]} · "
            f"裁剪 {crop.width:.2f}×{crop.height:.2f} @ ({crop.x0:.3f},{crop.y0:.3f})"
        )

    def _update_info(self, crop: core.Crop, out: tuple[int, int]) -> None:
        sx, sy = core.output_scale(crop, out)
        self.info.setText(
            f"输出 {out[0]}×{out[1]}，每输出像素覆盖 "
            f"{crop.width / out[0]:.4f}×{crop.height / out[1]:.4f} 个原采样。\n"
            f"裁剪窗口 ({crop.x0:.3f}, {crop.y0:.3f}) + {crop.width:.2f}×{crop.height:.2f}；"
            f"实际缩放 x={sx:.5f} y={sy:.5f}。\n"
            "点击预览可锁定像素，像素 RGBA 显示在状态栏。\n"
            "预乘 α 关闭后，透明像素的 RGB=0 会混进边缘 —— 观察“边缘-实心”变负。\n"
            "提示：面积/盒滤波的平均透明度应与原图整区一致；默认直接从原图缩放，"
            "与先缩一半再缩一半属于不同路径。"
        )

    def _update_plot(self) -> None:
        metric = self.plot_metric.currentData()
        steps = self.sweep_steps.value()
        crop_size = (self.crop_size.value(), self.crop_size.value())
        premul = self.premultiply.isChecked()
        mode = self.mode.currentData()

        series: dict[str, list[tuple[float, float]]] = {}
        if mode == "scale":
            # Sweep the full downscale range and always include the current
            # scale, so the curve shows where the preview lands.
            x_lo = min(0.004, self.scale.value())
            x_hi = max(1.5, self.scale.value())
            scales = np.linspace(x_lo, x_hi, steps)
            data = core.sweep_scales(
                self._image,
                crop_size,
                scales,
                premul,
                dx=self.offset_x.value(),
                dy=self.offset_y.value(),
            )
            x_label = "缩放比"
        else:
            axis = "x" if mode == "offset_x" else "y"
            limit = self.offset_x.value() if axis == "x" else self.offset_y.value()
            offsets = np.linspace(limit - 2.0, limit + 2.0, steps)
            data = core.sweep_offsets(
                self._image, crop_size, offsets, axis, self.scale.value(), premul
            )
            x_label = "偏移 (px)"
        marker = self.scale.value() if mode == "scale" else limit
        for key, points in data.items():
            series[key] = [(p.x, getattr(p.metrics, metric)) for p in points]
        label = dict(METRIC_FIELDS)[metric]
        self.plot.set_data(series, x_label, label, marker_x=marker)

    def _update_pixel_readout(self, x: int, y: int) -> None:
        parts = []
        for key in core.FILTER_ORDER:
            r = self._results.get(key)
            if r is None:
                continue
            if y < r.u8.shape[0] and x < r.u8.shape[1]:
                px = r.u8[y, x]
                parts.append(
                    f"{core.FILTERS[key].short}: rgba({px[0]},{px[1]},{px[2]},{px[3]})"
                )
        self.status.emit(f"像素 ({x},{y}) — " + " | ".join(parts))

    # -- export ------------------------------------------------------------ #
    def _on_export(self) -> None:
        from .export import ExportDialog

        dialog = ExportDialog(self)
        dialog.exec()
