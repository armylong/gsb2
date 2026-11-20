"""PySide6 图形界面：灰阶量化色带观察器。"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPoint, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QImage, QPainter, QPen
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QSplitter,
    QTabWidget,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from .analysis import boundary_mask, error_map, error_stats
from .imageutils import boundary_overlay, gray_to_qimage, rgb_to_qimage
from .levels import (
    describe_levels,
    level_index_on_8bit,
    parse_custom_levels,
    spaced_levels,
)
from .patterns import PATTERN_KINDS, PATTERN_LABELS, generate_pattern
from .pngio import read_png, write_png
from .quantize import METHODS, METHOD_LABELS, quantize
from .workers import compute_async

CHECKER = 16  # 透明棋盘格边长（像素）


class ImageView(QWidget):
    """等比缩放显示 QImage，背景画透明棋盘格；点击回报图像像素坐标。"""

    clicked = Signal(int, int)
    activated = Signal(int, int)

    def __init__(self, title: str = "") -> None:
        super().__init__()
        self._image: QImage | None = None
        self._overlay: QImage | None = None
        self.setMinimumSize(320, 240)
        self.setMouseTracking(True)
        self.setStatusTip(title)

    def set_image(self, image: QImage | None, overlay: QImage | None = None) -> None:
        self._image = image
        self._overlay = overlay
        self.update()

    def _target_rect(self) -> tuple[int, int, int, int]:
        if self._image is None:
            return 0, 0, 0, 0
        iw, ih = self._image.width(), self._image.height()
        w, h = max(1, self.width()), max(1, self.height())
        scale = min(w / iw, h / ih)
        dw, dh = int(iw * scale), int(ih * scale)
        return (w - dw) // 2, (h - dh) // 2, dw, dh

    def _map_xy(self, pos: QPoint) -> tuple[int, int] | None:
        if self._image is None:
            return None
        x0, y0, dw, dh = self._target_rect()
        if not (x0 <= pos.x() < x0 + dw and y0 <= pos.y() < y0 + dh):
            return None
        ix = int((pos.x() - x0) / dw * self._image.width())
        iy = int((pos.y() - y0) / dh * self._image.height())
        return ix, iy

    def mousePressEvent(self, event) -> None:
        xy = self._map_xy(event.position().toPoint())
        if xy:
            self.clicked.emit(*xy)

    def mouseDoubleClickEvent(self, event) -> None:
        xy = self._map_xy(event.position().toPoint())
        if xy:
            self.activated.emit(*xy)

    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.fillRect(self.rect(), Qt.GlobalColor.darkGray)
        if self._image is None:
            painter.end()
            return
        x0, y0, dw, dh = self._target_rect()
        # 透明棋盘格
        light = Qt.GlobalColor.lightGray
        dark = Qt.GlobalColor.gray
        for gy in range(y0, y0 + dh, CHECKER):
            for gx in range(x0, x0 + dw, CHECKER):
                cw = min(CHECKER, x0 + dw - gx)
                ch = min(CHECKER, y0 + dh - gy)
                odd = ((gx - x0) // CHECKER + (gy - y0) // CHECKER) % 2
                painter.fillRect(gx, gy, cw, ch, light if odd == 0 else dark)
        target = QRectF(x0, y0, dw, dh)
        # 默认最近邻，不做插值，避免缩放掩盖色带
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, False)
        painter.drawImage(target, self._image)
        if self._overlay is not None:
            painter.drawImage(target, self._overlay)
        painter.setPen(QPen(Qt.GlobalColor.white, 1))
        painter.drawRect(x0, y0, dw, dh)
        painter.end()


class ZoomCanvas(QWidget):
    """按真实像素（最近邻、无平滑）放大图像局部，带像素网格与中心十字。

    每个画布持有自己的 QImage，保证原图与量化图显示不同内容。
    """

    def __init__(self, image: QImage, dialog: "ZoomDialog") -> None:
        super().__init__()
        self.image = image
        self.dialog = dialog
        self.setMinimumSize(380, 380)
        self.setMouseTracking(True)

    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.fillRect(self.rect(), Qt.GlobalColor.darkGray)
        d = self.dialog
        img, zoom = self.image, d.zoom
        half = d.half
        x0 = max(0, d.cx - half)
        y0 = max(0, d.cy - half)
        x1 = min(img.width(), d.cx + half + 1)
        y1 = min(img.height(), d.cy + half + 1)
        rw, rh = (x1 - x0) * zoom, (y1 - y0) * zoom
        ox = max(0, (self.width() - rw) // 2)
        oy = max(0, (self.height() - rh) // 2)
        # 棋盘底（透明像素处可见）
        for yy in range(y0, y1):
            for xx in range(x0, x1):
                odd = (xx + yy) % 2
                painter.fillRect(ox + (xx - x0) * zoom, oy + (yy - y0) * zoom,
                                 zoom, zoom,
                                 Qt.GlobalColor.lightGray if odd == 0 else Qt.GlobalColor.gray)
        source = QRectF(x0, y0, x1 - x0, y1 - y0)
        target = QRectF(ox, oy, rw, rh)
        # 关闭平滑后，drawImage 即按最近邻放大，每个源像素显示为真实方块
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, False)
        painter.drawImage(target, img, source)
        # 色带边界红框（仅量化图画布需要时由 dialog 控制）
        if d.show_boundary and d.boundary is not None:
            painter.setPen(QPen(Qt.GlobalColor.red, max(1, zoom // 8)))
            for yy in range(y0, y1):
                for xx in range(x0, x1):
                    if d.boundary[yy, xx]:
                        painter.drawRect(ox + (xx - x0) * zoom, oy + (yy - y0) * zoom,
                                         zoom, zoom)
        # 像素网格
        if zoom >= 6:
            painter.setPen(QPen(QColor(90, 90, 90, 110), 1))
            for gx in range(x0, x1 + 1):
                painter.drawLine(ox + (gx - x0) * zoom, oy,
                                 ox + (gx - x0) * zoom, oy + rh)
            for gy in range(y0, y1 + 1):
                painter.drawLine(ox, oy + (gy - y0) * zoom,
                                 ox + rw, oy + (gy - y0) * zoom)
        # 中心十字
        painter.setPen(QPen(Qt.GlobalColor.yellow, 2))
        cxp = ox + (d.cx - x0) * zoom
        cyp = oy + (d.cy - y0) * zoom
        painter.drawLine(cxp, oy, cxp, oy + rh)
        painter.drawLine(ox, cyp, ox + rw, cyp)
        painter.end()

    def mouseMoveEvent(self, event) -> None:
        self.dialog.report_pixel(event.position().toPoint(), self)


class ZoomDialog(QWidget):
    """同一位置的原图/量化图并排真实像素放大窗口。"""

    def __init__(self, source_q: QImage, quant_q: QImage,
                 gray: np.ndarray, qgray: np.ndarray, alpha: np.ndarray,
                 levels: np.ndarray, boundary: np.ndarray,
                 cx: int, cy: int) -> None:
        super().__init__()
        self.setWindowTitle("局部放大（真实像素，无平滑）")
        self.gray = gray
        self.qgray = qgray
        self.alpha = alpha
        self.levels = levels
        self.boundary = boundary
        self.show_boundary = True
        h, w = gray.shape
        self.cx = int(np.clip(cx, 0, w - 1))
        self.cy = int(np.clip(cy, 0, h - 1))
        self.zoom = 8
        self.half = 16

        self.canvas_src = ZoomCanvas(source_q, self)
        self.canvas_q = ZoomCanvas(quant_q, self)

        self.x_spin = QSpinBox()
        self.x_spin.setRange(0, w - 1)
        self.x_spin.setValue(self.cx)
        self.y_spin = QSpinBox()
        self.y_spin.setRange(0, h - 1)
        self.y_spin.setValue(self.cy)
        self.zoom_combo = QComboBox()
        self.zoom_combo.addItems(["4", "8", "16", "32"])
        self.zoom_combo.setCurrentText(str(self.zoom))
        self.half_combo = QComboBox()
        self.half_combo.addItems(["8", "16", "24", "32"])
        self.half_combo.setCurrentText(str(self.half))
        self.boundary_toggle = QCheckBox("量化图画色带边界")
        self.boundary_toggle.setChecked(True)
        self.status = QLabel("移动鼠标查看像素值")
        self.status.setStyleSheet("font-family: Menlo, monospace;")

        bar = QHBoxLayout()
        bar.addWidget(QLabel("中心 X"))
        bar.addWidget(self.x_spin)
        bar.addWidget(QLabel("Y"))
        bar.addWidget(self.y_spin)
        bar.addWidget(QLabel("放大倍数"))
        bar.addWidget(self.zoom_combo)
        bar.addWidget(QLabel("半宽"))
        bar.addWidget(self.half_combo)
        bar.addWidget(self.boundary_toggle)
        bar.addStretch(1)

        top = QHBoxLayout()
        top.addWidget(self._titled("原图（加噪后连续值）", self.canvas_src), 1)
        top.addWidget(self._titled("量化结果（仅取指定灰阶）", self.canvas_q), 1)

        layout = QVBoxLayout(self)
        layout.addLayout(bar)
        layout.addLayout(top, 1)
        layout.addWidget(self.status)
        self.resize(960, 620)

        self.x_spin.valueChanged.connect(self._move)
        self.y_spin.valueChanged.connect(self._move)
        self.zoom_combo.currentTextChanged.connect(self._set_zoom)
        self.half_combo.currentTextChanged.connect(self._set_half)
        self.boundary_toggle.toggled.connect(self._toggle_boundary)

    def _toggle_boundary(self, on: bool) -> None:
        self.show_boundary = on
        self.canvas_src.update()
        self.canvas_q.update()

    @staticmethod
    def _titled(title: str, widget: QWidget) -> QWidget:
        box = QGroupBox(title)
        lay = QVBoxLayout(box)
        lay.addWidget(widget)
        return box

    def _move(self) -> None:
        self.cx = self.x_spin.value()
        self.cy = self.y_spin.value()
        self.canvas_src.update()
        self.canvas_q.update()

    def _set_zoom(self, text: str) -> None:
        self.zoom = int(text)
        self.canvas_src.update()
        self.canvas_q.update()

    def _set_half(self, text: str) -> None:
        self.half = int(text)
        self.canvas_src.update()
        self.canvas_q.update()

    def report_pixel(self, pos, canvas: ZoomCanvas) -> None:
        # 反算鼠标对应的像素坐标
        img = canvas.image
        half = self.half
        x0 = max(0, self.cx - half)
        y0 = max(0, self.cy - half)
        x1 = min(img.width(), self.cx + half + 1)
        y1 = min(img.height(), self.cy + half + 1)
        rw, rh = (x1 - x0) * self.zoom, (y1 - y0) * self.zoom
        ox = max(0, (canvas.width() - rw) // 2)
        oy = max(0, (canvas.height() - rh) // 2)
        if not (ox <= pos.x() < ox + rw and oy <= pos.y() < oy + rh):
            return
        px = x0 + (pos.x() - ox) // self.zoom
        py = y0 + (pos.y() - oy) // self.zoom
        src_v = float(self.gray[py, px])
        q_v = float(self.qgray[py, px])
        idx = int(np.argmin(np.abs(self.levels - q_v)))
        a = float(self.alpha[py, px])
        self.status.setText(
            f"像素(x={px}, y={py})  原图={src_v:.4f}({round(src_v * 255)})  "
            f"量化={q_v:.4f}({round(q_v * 255)})  级别#{idx}/{self.levels.size - 1}  "
            f"alpha={a:.2f}  误差={q_v - src_v:+.4f}"
        )


class CompareDialog(QWidget):
    """同一级别设置下数种量化方法的并排比较（同步计算，带等待光标）。"""

    def __init__(self, noisy: np.ndarray, alpha: np.ndarray, levels: np.ndarray,
                 seed: int, bayer_order: int) -> None:
        super().__init__()
        self.setWindowTitle("量化方法比较")
        self.resize(1200, 800)
        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            cards = QHBoxLayout()
            cards.setSpacing(8)
            for method in METHODS:
                q = quantize(noisy, alpha, levels, method=method,
                             seed=seed, bayer_order=bayer_order)
                err = error_map(noisy, q, alpha)
                stats = error_stats(err, alpha)
                bm = boundary_mask(q, alpha)
                qimg = gray_to_qimage(q, alpha)
                overlay = boundary_overlay(q.shape, bm)
                card = QVBoxLayout()
                title = QLabel(f"{METHOD_LABELS[method]}\n"
                               f"MAE={stats['mae']:.4f} RMSE={stats['rmse']:.4f}\n"
                               f"边界像素={int(bm.sum())} 均值误差={stats['mean']:+.4f}")
                title.setStyleSheet("font-weight: bold;")
                view = ImageView()
                view.set_image(qimg, overlay)
                card.addWidget(title)
                card.addWidget(view, 1)
                wrap = QWidget()
                wrap.setLayout(card)
                cards.addWidget(wrap, 1)
        finally:
            QApplication.restoreOverrideCursor()
        scroll = QScrollArea()
        host = QWidget()
        host.setLayout(cards)
        scroll.setWidget(host)
        scroll.setWidgetResizable(True)
        lay = QVBoxLayout(self)
        lay.addWidget(QLabel(f"级别数={levels.size}：{describe_levels(levels)}"))
        lay.addWidget(scroll, 1)


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("BandViewer — 灰阶量化色带观察器")
        self.resize(1480, 920)

        self.gray: np.ndarray | None = None
        self.alpha: np.ndarray | None = None
        self.result: dict | None = None
        self._thread = None
        self._worker = None
        self._pending = False
        self._custom_levels: np.ndarray | None = None

        self._build_controls()
        self._build_views()
        self._wire()
        self.load_pattern()

    # ---------------- 界面搭建 ----------------
    def _build_controls(self) -> None:
        panel = QWidget()
        panel.setFixedWidth(300)
        root = QVBoxLayout(panel)

        # 测试图
        g1 = QGroupBox("1. 测试图（程序内生成）")
        f1 = QFormLayout(g1)
        self.pattern_combo = QComboBox()
        for kind in PATTERN_KINDS:
            self.pattern_combo.addItem(PATTERN_LABELS[kind], kind)
        self.size_combo = QComboBox()
        self.size_combo.addItems(["256", "384", "512"])
        self.size_combo.setCurrentText("384")
        self.open_btn = QPushButton("打开外部 PNG（灰度/带透明均可）")
        f1.addRow("图案", self.pattern_combo)
        f1.addRow("边长", self.size_combo)
        f1.addRow(self.open_btn)
        root.addWidget(g1)

        # 灰阶
        g2 = QGroupBox("2. 自定义灰阶")
        f2 = QFormLayout(g2)
        self.count_spin = QSpinBox()
        self.count_spin.setRange(2, 64)
        self.count_spin.setValue(8)
        self.spacing_combo = QComboBox()
        self.spacing_combo.addItem("等间距", "uniform")
        self.spacing_combo.addItem("暗部密集 gamma^2.2", "gamma-dark")
        self.spacing_combo.addItem("亮部密集 gamma^(1/2.2)", "gamma-light")
        self.gamma_spin = QDoubleSpinBox()
        self.gamma_spin.setRange(0.2, 5.0)
        self.gamma_spin.setSingleStep(0.1)
        self.gamma_spin.setValue(2.2)
        self.custom_edit = QLineEdit()
        self.custom_edit.setPlaceholderText("如 0 32 64 128 192 255；留空用上面的方案")
        self.apply_custom_btn = QPushButton("应用自定义灰阶")
        self.clear_custom_btn = QPushButton("清除自定义，恢复方案")
        self.levels_label = QLabel()
        self.levels_label.setWordWrap(True)
        self.levels_label.setStyleSheet("font-family: Menlo, monospace; font-size: 11px;")
        f2.addRow("级数", self.count_spin)
        f2.addRow("间距", self.spacing_combo)
        f2.addRow("gamma", self.gamma_spin)
        f2.addRow("自定义值", self.custom_edit)
        f2.addRow(self.apply_custom_btn)
        f2.addRow(self.clear_custom_btn)
        f2.addRow("当前级别", self.levels_label)
        root.addWidget(g2)

        # 量化
        g3 = QGroupBox("3. 量化与噪声")
        f3 = QFormLayout(g3)
        self.method_combo = QComboBox()
        for m in METHODS:
            self.method_combo.addItem(METHOD_LABELS[m], m)
        self.bayer_combo = QComboBox()
        self.bayer_combo.addItems(["2 (2x2 矩阵)", "3 (8x8 矩阵)", "4 (16x16 矩阵)"])
        self.bayer_combo.setCurrentIndex(1)
        self.noise_spin = QDoubleSpinBox()
        self.noise_spin.setRange(0.0, 0.2)
        self.noise_spin.setSingleStep(0.005)
        self.noise_spin.setDecimals(3)
        self.noise_spin.setValue(0.02)
        self.seed_spin = QSpinBox()
        self.seed_spin.setRange(0, 1_000_000)
        self.seed_spin.setValue(42)
        f3.addRow("方法", self.method_combo)
        f3.addRow("Bayer 阶数", self.bayer_combo)
        f3.addRow("噪声强度", self.noise_spin)
        f3.addRow("随机种子", self.seed_spin)
        root.addWidget(g3)

        # 显示
        g4 = QGroupBox("4. 显示与输出")
        f4 = QFormLayout(g4)
        self.boundary_check = QCheckBox("在结果上叠加色带边界（红）")
        self.boundary_check.setChecked(True)
        self.compare_btn = QPushButton("并排比较全部量化方法")
        self.zoom_btn = QPushButton("局部放大（真实像素）")
        self.export_gray_btn = QPushButton("导出灰阶图 PNG（保留透明）")
        self.export_err_btn = QPushButton("导出误差图 PNG（保留透明）")
        f4.addRow(self.boundary_check)
        f4.addRow(self.compare_btn)
        f4.addRow(self.zoom_btn)
        f4.addRow(self.export_gray_btn)
        f4.addRow(self.export_err_btn)
        root.addWidget(g4)

        self.status_label = QLabel("就绪")
        self.status_label.setWordWrap(True)
        root.addWidget(self.status_label)
        root.addStretch(1)

        scroll = QScrollArea()
        scroll.setWidget(panel)
        scroll.setWidgetResizable(True)
        scroll.setFixedWidth(320)
        self.control_panel = scroll

    def _build_views(self) -> None:
        self.tabs = QTabWidget()
        self.view_source = ImageView("原图")
        self.view_quant = ImageView("量化")
        self.view_error = ImageView("误差")
        self.tabs.addTab(self.view_source, "原图（加噪后）")
        self.tabs.addTab(self.view_quant, "灰阶结果")
        self.tabs.addTab(self.view_error, "误差图（红=量化偏高 蓝=偏低）")

        # 下方面板：每级像素数表 + 误差统计 + 边界列表
        self.hist_table = QTableWidget(0, 4)
        self.hist_table.setHorizontalHeaderLabels(["级别#", "灰阶值", "8-bit", "像素数(占比)"])
        self.hist_table.horizontalHeader().setStretchLastSection(True)
        self.stats_label = QLabel()
        self.stats_label.setStyleSheet("font-family: Menlo, monospace;")
        self.transition_table = QTableWidget(0, 5)
        self.transition_table.setHorizontalHeaderLabels(
            ["扫描行", "位置x", "起始级", "到达级", "跳变值"]
        )
        self.transition_table.horizontalHeader().setStretchLastSection(True)

        bottom = QSplitter(Qt.Orientation.Horizontal)
        left_box = QWidget()
        lb = QVBoxLayout(left_box)
        lb.addWidget(QLabel("每级像素数（透明像素不计入）"))
        lb.addWidget(self.hist_table, 1)
        lb.addWidget(self.stats_label)
        right_box = QWidget()
        rb = QVBoxLayout(right_box)
        rb.addWidget(QLabel("色带边界（抽样扫描线，前 16 行）"))
        rb.addWidget(self.transition_table, 1)
        bottom.addWidget(left_box)
        bottom.addWidget(right_box)
        bottom.setSizes([520, 520])

        splitter = QSplitter(Qt.Orientation.Vertical)
        splitter.addWidget(self.tabs)
        splitter.addWidget(bottom)
        splitter.setSizes([560, 320])

        central = QSplitter(Qt.Orientation.Horizontal)
        central.addWidget(self.control_panel)
        central.addWidget(splitter)
        central.setStretchFactor(1, 1)
        self.setCentralWidget(central)

    def _wire(self) -> None:
        self.pattern_combo.currentIndexChanged.connect(self.load_pattern)
        self.size_combo.currentTextChanged.connect(self.load_pattern)
        self.open_btn.clicked.connect(self.open_png)
        self.count_spin.valueChanged.connect(self.recompute)
        self.spacing_combo.currentIndexChanged.connect(self.recompute)
        self.gamma_spin.valueChanged.connect(self.recompute)
        self.apply_custom_btn.clicked.connect(self.apply_custom_levels)
        self.clear_custom_btn.clicked.connect(self.clear_custom_levels)
        self.method_combo.currentIndexChanged.connect(self.recompute)
        self.bayer_combo.currentIndexChanged.connect(self.recompute)
        self.noise_spin.valueChanged.connect(self.recompute)
        self.seed_spin.valueChanged.connect(self.recompute)
        self.boundary_check.toggled.connect(self.refresh_views)
        self.compare_btn.clicked.connect(self.open_compare)
        self.zoom_btn.clicked.connect(lambda: self.open_zoom(self.gray.shape[1] // 2,
                                                             self.gray.shape[0] // 2))
        self.export_gray_btn.clicked.connect(self.export_gray)
        self.export_err_btn.clicked.connect(self.export_error)
        for view in (self.view_source, self.view_quant):
            view.activated.connect(self.open_zoom)
            view.clicked.connect(self._click_status)

    # ---------------- 数据与计算 ----------------
    def current_levels(self) -> np.ndarray:
        if self._custom_levels is not None:
            return self._custom_levels
        return spaced_levels(
            self.count_spin.value(),
            self.spacing_combo.currentData(),
            self.gamma_spin.value(),
        )

    def load_pattern(self) -> None:
        kind = self.pattern_combo.currentData()
        size = int(self.size_combo.currentText())
        self.gray, self.alpha = generate_pattern(kind, size)
        self._custom_levels = None
        self.custom_edit.clear()
        self.recompute()

    def open_png(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "打开 PNG", "", "PNG 图像 (*.png)")
        if not path:
            return
        try:
            self.gray, self.alpha = read_png(path)
        except Exception as exc:
            QMessageBox.critical(self, "读取失败", str(exc))
            return
        self.status_label.setText(f"已加载 {path}，尺寸 {self.gray.shape[1]}x{self.gray.shape[0]}")
        self.recompute()

    def apply_custom_levels(self) -> None:
        try:
            self._custom_levels = parse_custom_levels(self.custom_edit.text())
        except ValueError as exc:
            QMessageBox.warning(self, "自定义灰阶无效", str(exc))
            return
        self.recompute()

    def clear_custom_levels(self) -> None:
        self._custom_levels = None
        self.custom_edit.clear()
        self.recompute()

    def recompute(self) -> None:
        if self.gray is None:
            return
        if self._thread is not None:
            # 上一轮还在跑：标记待重算，当前轮结束后自动按最新参数再来一次
            self._pending = True
            return
        levels = self.current_levels()
        self.levels_label.setText(describe_levels(levels))
        method = self.method_combo.currentData()
        bayer_order = int(self.bayer_combo.currentText().split()[0])
        self.status_label.setText("计算中…")
        self._thread, self._worker = compute_async(
            self.gray, self.alpha, levels, method,
            self.noise_spin.value(), self.seed_spin.value(), bayer_order,
        )
        self._worker.finished.connect(self.on_computed)
        self._worker.failed.connect(self.on_failed)
        self._thread.start()

    def _release_thread(self) -> None:
        """等线程真正退出后释放 Python 引用，由引用计数回收 Qt 对象。"""
        if self._thread is not None:
            self._thread.wait()
        self._thread = None
        self._worker = None

    def on_computed(self, result: dict) -> None:
        self.result = result
        self._release_thread()
        self.refresh_views()
        self.refresh_tables()
        s = result["stats"]
        self.status_label.setText(
            f"完成：MAE={s['mae']:.4f} RMSE={s['rmse']:.4f} "
            f"误差范围 [{s['min']:+.4f}, {s['max']:+.4f}]，边界像素 {int(result['boundary'].sum())} 个"
        )
        if self._pending:
            self._pending = False
            self.recompute()

    def on_failed(self, message: str) -> None:
        self._release_thread()
        self.status_label.setText(f"计算失败：{message}")
        QMessageBox.critical(self, "计算失败", message)

    # ---------------- 展示 ----------------
    def refresh_views(self) -> None:
        if self.result is None:
            return
        r = self.result
        src_img = gray_to_qimage(r["noisy"], r["alpha"])
        q_img = gray_to_qimage(r["q"], r["alpha"])
        err_img = rgb_to_qimage(r["err_rgb"], r["alpha"])
        self.view_source.set_image(src_img)
        overlay = boundary_overlay(r["q"].shape, r["boundary"]) if self.boundary_check.isChecked() else None
        self.view_quant.set_image(q_img, overlay)
        self.view_error.set_image(err_img)

    def refresh_tables(self) -> None:
        r = self.result
        levels = self.current_levels()
        hist = r["hist"]
        eights = level_index_on_8bit(levels)
        total = max(1, int(hist.sum()))
        self.hist_table.setRowCount(levels.size)
        for i, (lv, q8, cnt) in enumerate(zip(levels, eights, hist)):
            vals = [str(i), f"{lv:.4f}", str(int(q8)), f"{int(cnt)} ({cnt / total:.1%})"]
            for col, val in enumerate(vals):
                item = QTableWidgetItem(val)
                if col < 3:
                    item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                self.hist_table.setItem(i, col, item)
        s = r["stats"]
        self.stats_label.setText(
            f"不透明像素={s['count']}  MAE={s['mae']:.5f}  RMSE={s['rmse']:.5f}\n"
            f"均值误差={s['mean']:+.5f}  最小={s['min']:+.5f}  最大={s['max']:+.5f}"
        )
        transitions = r["transitions"]
        self.transition_table.setRowCount(len(transitions))
        for row, t in enumerate(transitions):
            vals = [
                str(t.get("row", t.get("col", -1))),
                str(t["pos"]),
                f"#{t['from_idx']} ({t['from_value']:.3f})",
                f"#{t['to_idx']} ({t['to_value']:.3f})",
                f"{t['to_value'] - t['from_value']:+.3f}",
            ]
            for col, val in enumerate(vals):
                self.transition_table.setItem(row, col, QTableWidgetItem(val))

    def _click_status(self, x: int, y: int) -> None:
        if self.result is None:
            return
        r = self.result
        self.status_label.setText(
            f"选中像素(x={x}, y={y})：原图={r['noisy'][y, x]:.4f} "
            f"量化={r['q'][y, x]:.4f} alpha={r['alpha'][y, x]:.2f}（双击打开局部放大）"
        )

    # ---------------- 子窗口 ----------------
    def open_zoom(self, cx: int, cy: int) -> None:
        if self.result is None:
            return
        r = self.result
        src_img = gray_to_qimage(r["noisy"], r["alpha"])
        q_img = gray_to_qimage(r["q"], r["alpha"])
        # ZoomCanvas 通过属性读 image，这里给两个画布分别挂自己的图
        dlg = ZoomDialog(src_img, q_img, r["noisy"], r["q"], r["alpha"],
                         self.current_levels(), r["boundary"], cx, cy)
        dlg.setWindowModality(Qt.WindowModality.NonModal)
        dlg.show()
        self._zoom_dlg = dlg  # 保活，避免被回收

    def open_compare(self) -> None:
        if self.result is None:
            return
        r = self.result
        dlg = CompareDialog(r["noisy"], r["alpha"], self.current_levels(),
                            self.seed_spin.value(),
                            int(self.bayer_combo.currentText().split()[0]))
        dlg.show()
        self._compare_dlg = dlg

    # ---------------- 导出 ----------------
    def _ask_save_path(self, name: str) -> str | None:
        path, _ = QFileDialog.getSaveFileName(self, "导出 PNG", name, "PNG (*.png)")
        return path or None

    def export_gray(self) -> None:
        if self.result is None:
            return
        path = self._ask_save_path("quantized_gray.png")
        if path:
            write_png(path, self.result["q"], self.result["alpha"])
            self.status_label.setText(f"已导出灰阶图：{path}")

    def export_error(self) -> None:
        if self.result is None:
            return
        path = self._ask_save_path("error_map.png")
        if path:
            write_png(path, self.result["err_rgb"], self.result["alpha"])
            self.status_label.setText(f"已导出误差图：{path}")


def run_gui() -> int:
    app = QApplication.instance() or QApplication([])
    win = MainWindow()
    win.show()
    return app.exec()
