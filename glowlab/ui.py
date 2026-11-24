"""PySide6 辉光实验台窗口。

布局：左侧参数面板 | 右侧上下两张图 (全图 / 分区放大)。
全图与放大图永远来自同一份全图 RenderResult，放大只是像素级切片，
因此不存在裁小窗口重算导致的亮晕变形。
"""

from __future__ import annotations

import os

import numpy as np
from PySide6.QtCore import Qt, QTimer, Signal, Slot
from PySide6.QtGui import QAction, QImage, QPainter, QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QFrame,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSlider,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from . import engine, test_patterns
from .worker import WorkerThread

AMBER = np.array([1.0, 0.72, 0.0], dtype=np.float32)

VIEW_MODES = [
    "原图 + 资格像素(琥珀色)",
    "资格蒙版 (灰度)",
    "辉光合成结果",
    "辉光层 (黑底: 近场+长尾)",
    "近场辉光层",
    "红色长尾层",
    "贡献对照 (近场 | 长尾)",
]

ZOOM_SIZES = [64, 96, 128, 192]


# ---------------------------------------------------------------- 图像转换

def np_to_qimage(rgb_uint8: np.ndarray) -> QImage:
    arr = np.ascontiguousarray(rgb_uint8)
    h, w = arr.shape[:2]
    return QImage(arr.data, w, h, w * 3, QImage.Format.Format_RGB888).copy()


def np_to_pixmap(rgb_float: np.ndarray) -> QPixmap:
    return QPixmap.fromImage(np_to_qimage(engine.to_uint8(rgb_float)))


# ---------------------------------------------------------------- 参数行

class ParamRow(QWidget):
    """滑杆 + 数字框 同步的一行参数。"""

    changed = Signal()

    def __init__(self, label: str, value: float, lo: float, hi: float,
                 step: float, decimals: int) -> None:
        super().__init__()
        self.lo, self.hi = lo, hi
        self.decimals = decimals
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        self.name = QLabel(label)
        self.name.setMinimumWidth(72)
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setRange(0, 1000)
        self.spin = QDoubleSpinBox()
        self.spin.setRange(lo, hi)
        self.spin.setSingleStep(step)
        self.spin.setDecimals(decimals)
        self.spin.setFixedWidth(86)
        layout.addWidget(self.name)
        layout.addWidget(self.slider, 1)
        layout.addWidget(self.spin)
        self.set_value(value)
        self.slider.valueChanged.connect(self._from_slider)
        self.spin.valueChanged.connect(self._from_spin)

    def _from_slider(self, pos: int) -> None:
        v = self.lo + (self.hi - self.lo) * pos / 1000.0
        for box in (self.spin,):
            box.blockSignals(True)
            box.setValue(v)
            box.blockSignals(False)
        self.changed.emit()

    def _from_spin(self) -> None:
        v = self.spin.value()
        pos = round((v - self.lo) / (self.hi - self.lo) * 1000)
        self.slider.blockSignals(True)
        self.slider.setValue(pos)
        self.slider.blockSignals(False)
        self.changed.emit()

    def set_value(self, v: float) -> None:
        self.spin.blockSignals(True)
        self.slider.blockSignals(True)
        self.spin.setValue(float(v))
        pos = round((float(v) - self.lo) / (self.hi - self.lo) * 1000)
        self.slider.setValue(pos)
        self.spin.blockSignals(False)
        self.slider.blockSignals(False)

    def value(self) -> float:
        return float(self.spin.value())


# ---------------------------------------------------------------- 可点击图

class ImageLabel(QLabel):
    """带信箱缩放坐标映射的图像标签，点击/悬停回传原图坐标。"""

    clicked_at = Signal(int, int)
    hovered_at = Signal(int, int)

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setMouseTracking(True)
        self.setMinimumSize(320, 240)
        self.setStyleSheet("background:#111; color:#888;")
        self._dims = None  # (W, H)

    def set_dims(self, w: int, h: int) -> None:
        self._dims = (w, h)

    def _map_pos(self, pos):
        if not self._dims or self.pixmap() is None:
            return None
        w, h = self._dims
        pw, ph = self.pixmap().size().width(), self.pixmap().size().height()
        ox = (self.width() - pw) / 2.0
        oy = (self.height() - ph) / 2.0
        x = (pos.x() - ox) / pw * w
        y = (pos.y() - oy) / ph * h
        if 0 <= x < w and 0 <= y < h:
            return int(x), int(y)
        return None

    def mousePressEvent(self, event) -> None:
        p = self._map_pos(event.position())
        if p:
            self.clicked_at.emit(*p)

    def mouseMoveEvent(self, event) -> None:
        p = self._map_pos(event.position())
        if p:
            self.hovered_at.emit(*p)


# ---------------------------------------------------------------- 主窗口

class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("GlowLab — 暗部红晕双层辉光实验台")
        self.resize(1440, 900)

        self.image: np.ndarray | None = None
        self._image_float: np.ndarray | None = None
        self.result: engine.RenderResult | None = None
        self.zoom_cx = self.zoom_cy = 0
        self.zoom_size = ZOOM_SIZES[1]
        self._export_dir = os.getcwd()

        self.worker = WorkerThread()
        self.worker.worker.finished.connect(self._on_rendered)
        self.worker.worker.failed.connect(self._on_failed)
        self._debounce = QTimer(self)
        self._debounce.setSingleShot(True)
        self._debounce.setInterval(40)
        self._debounce.timeout.connect(self._dispatch)

        self._build_ui()
        self.load_array(test_patterns.red_paint(), "样图1: 暗红颜料与点源")

    # ------------------------------------------------------------ UI 搭建

    def _build_ui(self) -> None:
        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.addWidget(self._build_panel())
        splitter.addWidget(self._build_views())
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([330, 1110])
        self.setCentralWidget(splitter)
        self._build_menu()
        self.statusBar().showMessage("就绪。点击全图可移动放大预览中心。")

    def _build_panel(self) -> QWidget:
        panel = QWidget()
        v = QVBoxLayout(panel)

        box_src = QGroupBox("1. 高光来源")
        lay_src = QVBoxLayout(box_src)
        btn_open = QPushButton("打开本地彩色图片…")
        btn_open.clicked.connect(self.open_file)
        lay_src.addWidget(btn_open)
        for name, fn in test_patterns.PATTERNS.items():
            b = QPushButton(name)
            b.clicked.connect(lambda _=False, f=fn, n=name: self.load_array(f(), n))
            lay_src.addWidget(b)
        v.addWidget(box_src)

        box_q = QGroupBox("2. 资格门槛 (只看亮度, 与颜色无关)")
        fq = QFormLayout(box_q)
        self.row_threshold = ParamRow("门槛亮度", 0.70, 0.05, 1.0, 0.01, 2)
        self.row_softness = ParamRow("出现过渡", 0.10, 0.005, 0.50, 0.005, 3)
        fq.addRow(self.row_threshold)
        fq.addRow(self.row_softness)
        v.addWidget(box_q)

        box_near = QGroupBox("3a. 近场辉光 (原色, 短距离)")
        fn1 = QFormLayout(box_near)
        self.row_near_sigma = ParamRow("范围 px", 8.0, 0.5, 60.0, 0.5, 1)
        self.row_near_strength = ParamRow("强度", 0.60, 0.0, 2.0, 0.05, 2)
        fn1.addRow(self.row_near_sigma)
        fn1.addRow(self.row_near_strength)
        v.addWidget(box_near)

        box_tail = QGroupBox("3b. 红色长尾 (可染色, 长距离)")
        fn2 = QFormLayout(box_tail)
        self.row_tail_sigma = ParamRow("范围 px", 32.0, 1.0, 200.0, 1.0, 1)
        self.row_tail_strength = ParamRow("强度", 0.45, 0.0, 2.0, 0.05, 2)
        self.row_red_tint = ParamRow("染红程度", 0.80, 0.0, 1.0, 0.05, 2)
        fn2.addRow(self.row_tail_sigma)
        fn2.addRow(self.row_tail_strength)
        fn2.addRow(self.row_red_tint)
        v.addWidget(box_tail)

        self.rows = [
            self.row_threshold, self.row_softness,
            self.row_near_sigma, self.row_near_strength,
            self.row_tail_sigma, self.row_tail_strength, self.row_red_tint,
        ]
        for row in self.rows:
            row.changed.connect(self._schedule)

        box_view = QGroupBox("4. 显示与对照")
        fv = QFormLayout(box_view)
        self.combo_mode = QComboBox()
        self.combo_mode.addItems(VIEW_MODES)
        self.combo_mode.currentIndexChanged.connect(self.refresh_views)
        self.combo_zoom = QComboBox()
        self.combo_zoom.addItems([f"{s} × {s} px" for s in ZOOM_SIZES])
        self.combo_zoom.setCurrentIndex(1)
        self.combo_zoom.currentIndexChanged.connect(self._zoom_size_changed)
        fv.addRow("全图模式", self.combo_mode)
        fv.addRow("放大窗口", self.combo_zoom)
        v.addWidget(box_view)

        box_out = QGroupBox("5. 导出")
        lo = QVBoxLayout(box_out)
        b1 = QPushButton("导出合成图片 PNG…")
        b1.clicked.connect(self.export_composite)
        b2 = QPushButton("导出贡献预览 PNG…")
        b2.clicked.connect(self.export_contribution)
        b3 = QPushButton("重置全部参数")
        b3.clicked.connect(self.reset_params)
        lo.addWidget(b1)
        lo.addWidget(b2)
        lo.addWidget(b3)
        v.addWidget(box_out)
        v.addStretch(1)
        return panel

    def _build_views(self) -> QWidget:
        wrap = QWidget()
        v = QVBoxLayout(wrap)
        self.full_label = ImageLabel()
        self.zoom_label = ImageLabel()
        self.full_caption = QLabel("全图 (点击任意位置移动放大中心)")
        self.zoom_caption = QLabel("分区放大 (与全图同一渲染结果的像素级切片)")
        for cap in (self.full_caption, self.zoom_caption):
            cap.setStyleSheet("color:#aaa; padding:2px;")
        for lab in (self.full_label, self.zoom_label):
            lab.clicked_at.connect(self._move_zoom_center)
        self.full_label.hovered_at.connect(self._probe)
        box1 = self._wrap_scroll(self.full_caption, self.full_label)
        box2 = self._wrap_scroll(self.zoom_caption, self.zoom_label)
        split = QSplitter(Qt.Orientation.Vertical)
        split.addWidget(box1)
        split.addWidget(box2)
        split.setStretchFactor(0, 3)
        split.setStretchFactor(1, 2)
        v.addWidget(split)
        return wrap

    @staticmethod
    def _wrap_scroll(caption: QLabel, label: ImageLabel) -> QFrame:
        frame = QFrame()
        v = QVBoxLayout(frame)
        v.setContentsMargins(4, 4, 4, 4)
        v.addWidget(caption)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(label)
        v.addWidget(scroll)
        return frame

    def _build_menu(self) -> None:
        m_file = self.menuBar().addMenu("文件")
        act_open = QAction("打开图片…", self)
        act_open.triggered.connect(self.open_file)
        act_comp = QAction("导出合成图片…", self)
        act_comp.triggered.connect(self.export_composite)
        act_contrib = QAction("导出贡献预览…", self)
        act_contrib.triggered.connect(self.export_contribution)
        act_quit = QAction("退出", self)
        act_quit.triggered.connect(self.close)
        m_file.addActions([act_open, act_comp, act_contrib])
        m_file.addSeparator()
        m_file.addAction(act_quit)

        m_help = self.menuBar().addMenu("帮助")
        act_about = QAction("实验说明", self)
        act_about.triggered.connect(self.show_about)
        m_help.addAction(act_about)

    # ------------------------------------------------------------ 参数/调度

    def _current_params(self) -> engine.GlowParams:
        return engine.GlowParams(
            threshold=self.row_threshold.value(),
            softness=self.row_softness.value(),
            near_sigma=self.row_near_sigma.value(),
            near_strength=self.row_near_strength.value(),
            tail_sigma=self.row_tail_sigma.value(),
            tail_strength=self.row_tail_strength.value(),
            red_tint=self.row_red_tint.value(),
        )

    def reset_params(self) -> None:
        defaults = engine.GlowParams()
        mapping = {
            self.row_threshold: defaults.threshold,
            self.row_softness: defaults.softness,
            self.row_near_sigma: defaults.near_sigma,
            self.row_near_strength: defaults.near_strength,
            self.row_tail_sigma: defaults.tail_sigma,
            self.row_tail_strength: defaults.tail_strength,
            self.row_red_tint: defaults.red_tint,
        }
        for row, val in mapping.items():
            row.set_value(val)
        self._schedule()

    def _schedule(self) -> None:
        self._debounce.start()

    def _dispatch(self) -> None:
        if self.image is not None:
            self.statusBar().showMessage("渲染中…")
            self.worker.request(self.image, self._current_params())

    @Slot(object, float)
    def _on_rendered(self, result: engine.RenderResult, dt: float) -> None:
        self.result = result
        self.refresh_views()
        n = int(np.count_nonzero(result.mask >= 0.5))
        pct = 100.0 * n / result.mask.size
        self.statusBar().showMessage(
            f"渲染 {dt * 1000:.0f} ms ｜ 资格像素 {n} ({pct:.2f}%) ｜ "
            f"图像 {result.mask.shape[1]}×{result.mask.shape[0]} ｜ "
            f"点击全图移动放大中心"
        )

    @Slot(str)
    def _on_failed(self, msg: str) -> None:
        QMessageBox.warning(self, "渲染失败", msg)

    # ------------------------------------------------------------ 载入图片

    def load_array(self, arr: np.ndarray, name: str) -> None:
        self.image = engine.to_uint8(engine.to_float_rgb(arr))
        self._image_float = engine.to_float_rgb(self.image)
        h, w = self.image.shape[:2]
        self.zoom_cx, self.zoom_cy = w // 2, h // 2
        self.full_label.set_dims(w, h)
        self.zoom_label.set_dims(*self._zoom_dims())
        self.setWindowTitle(f"GlowLab — {name}")
        if h * w > 4_000_000:
            self.statusBar().showMessage(
                f"大图 {w}×{h}：全分辨率渲染可能需要数秒，可先缩小后再处理。")
        self._dispatch()

    def open_file(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "打开彩色图片", self._export_dir,
            "图片 (*.png *.jpg *.jpeg *.bmp *.tif *.tiff *.webp)")
        if not path:
            return
        self._export_dir = os.path.dirname(path)
        qimg = QImage(path)
        if qimg.isNull():
            QMessageBox.warning(self, "无法打开", f"解码失败:\n{path}")
            return
        qimg = qimg.convertToFormat(QImage.Format.Format_RGB888)
        w, h = qimg.width(), qimg.height()
        ptr = qimg.constBits()
        arr = np.frombuffer(ptr, dtype=np.uint8, count=w * h * 3).reshape(h, w, 3)
        self.load_array(arr.copy(), os.path.basename(path))

    # ------------------------------------------------------------ 视图

    def _zoom_dims(self):
        s = min(self.zoom_size, self.image.shape[0], self.image.shape[1])
        return s, s

    def _zoom_rect(self):
        h, w = self.image.shape[:2]
        s = min(self.zoom_size, h, w)
        return engine.crop_region(h, w, self.zoom_cx, self.zoom_cy, s)

    def _zoom_size_changed(self, idx: int) -> None:
        self.zoom_size = ZOOM_SIZES[idx]
        self.zoom_label.set_dims(*self._zoom_dims())
        self.refresh_views()

    def _move_zoom_center(self, x: int, y: int) -> None:
        self.zoom_cx, self.zoom_cy = x, y
        self.refresh_views()

    def _mode_array_full(self, mode: int) -> np.ndarray:
        r = self.result
        if mode == 0:
            a = (r.mask * 0.45)[..., None]
            return self._image_float * (1.0 - a) + AMBER * a
        if mode == 1:
            return engine.mask_to_rgb(r.mask)
        if mode == 2:
            return r.composite
        if mode == 3:
            return np.clip(r.glow, 0, 1)
        if mode == 4:
            return np.clip(r.near, 0, 1)
        if mode == 5:
            return np.clip(r.tail, 0, 1)
        return engine.contribution_tiles(r)

    def _mode_array_zoom(self, mode: int, rect) -> np.ndarray:
        r = self.result
        if mode == 6:
            gap = 6
            near_c = engine.extract(np.clip(r.near, 0, 1), rect)
            tail_c = engine.extract(np.clip(r.tail, 0, 1), rect)
            h = near_c.shape[0]
            return np.concatenate(
                [near_c, np.zeros((h, gap, 3), dtype=np.float32), tail_c], axis=1)
        full = self._mode_array_full(mode)
        return engine.extract(full, rect)

    def refresh_views(self) -> None:
        if self.result is None or self.image is None:
            return
        mode = self.combo_mode.currentIndex()
        full_arr = self._mode_array_full(mode)
        rect = self._zoom_rect()
        zoom_arr = self._mode_array_zoom(mode, rect)

        pm_full = np_to_pixmap(full_arr).scaled(
            self.full_label.size(), Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation)
        pm_zoom = np_to_pixmap(zoom_arr).scaled(
            self.zoom_label.size(), Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.FastTransformation)
        self.full_label.setPixmap(pm_full)
        self.zoom_label.setPixmap(pm_zoom)
        y0, y1, x0, x1 = rect
        self.zoom_caption.setText(
            f"分区放大 {x1 - x0}×{y1 - y0} px ｜ 原图区域 x[{x0},{x1}) y[{y0},{y1}) "
            f"中心({self.zoom_cx},{self.zoom_cy}) — 全图结果的像素级切片")

    def _probe(self, x: int, y: int) -> None:
        if self.result is None:
            return
        r = self.result
        rgb = self.image[y, x]
        self.statusBar().showMessage(
            f"像素 ({x},{y}) RGB={tuple(int(v) for v in rgb)}  "
            f"luma={r.lum[y, x]:.3f}  资格蒙版={r.mask[y, x]:.3f}  "
            f"近场贡献={r.near[y, x].sum():.3f}  长尾贡献={r.tail[y, x].sum():.3f}")

    # ------------------------------------------------------------ 导出

    def _save_png(self, arr_uint8: np.ndarray, title: str, default_name: str) -> None:
        path, _ = QFileDialog.getSaveFileName(
            self, title, os.path.join(self._export_dir, default_name), "PNG (*.png)")
        if not path:
            return
        if not path.lower().endswith(".png"):
            path += ".png"
        if not np_to_qimage(arr_uint8).save(path, "PNG"):
            QMessageBox.warning(self, "导出失败", path)
            return
        self.statusBar().showMessage(f"已导出: {path}")

    def export_composite(self) -> None:
        if self.result is None:
            return
        self._save_png(engine.to_uint8(self.result.composite),
                       "导出合成图片", "glowlab_composite.png")

    def export_contribution(self) -> None:
        if self.result is None:
            return
        tiles = engine.to_uint8(engine.contribution_tiles(self.result))
        # 在分隔带上方标注两层名称
        qimg = np_to_qimage(tiles)
        painter = QPainter(qimg)
        painter.setPen(Qt.GlobalColor.white)
        font = painter.font()
        font.setPointSize(14)
        painter.setFont(font)
        w = self.result.near.shape[1]
        painter.drawText(12, 24, "NEAR (近场辉光)")
        painter.drawText(w + 20, 24, "RED TAIL (红色长尾)")
        painter.end()
        out = qimg.convertToFormat(QImage.Format.Format_RGB888)
        w2, h2 = out.width(), out.height()
        arr = np.frombuffer(out.constBits(), np.uint8,
                            count=w2 * h2 * 3).reshape(h2, w2, 3).copy()
        self._save_png(arr, "导出贡献预览", "glowlab_contribution.png")

    # ------------------------------------------------------------ 其它

    def show_about(self) -> None:
        QMessageBox.information(
            self, "实验说明",
            "GlowLab 双层辉光实验台\n\n"
            "1. 高光资格只由 Rec.709 亮度决定，smoothstep 控制门槛与过渡，\n"
            "   颜色不参与资格判断 —— 暗红颜料不会因为红而发光。\n"
            "2. 近场辉光与红色长尾是两个不同 sigma 的高斯层，强度、范围\n"
            "   分别可调，衰减差别可在贡献对照里直接测量。\n"
            "3. 卷积全部零填充 (画布外为黑场)，全图只渲染一次；放大预览\n"
            "   是同一结果的像素级切片，亮晕不会因裁小窗口而变形。\n"
            "4. 样图1 验证红颜料不发光；样图2 含贴边亮点与相邻亮点簇。")

    def closeEvent(self, event) -> None:
        self._debounce.stop()
        self.worker.shutdown()
        super().closeEvent(event)

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        # 只重采样已有渲染结果，不触发引擎重算
        if self.result is not None:
            QTimer.singleShot(0, self.refresh_views)


def main() -> int:
    app = QApplication([])
    win = MainWindow()
    win.show()
    return app.exec()
