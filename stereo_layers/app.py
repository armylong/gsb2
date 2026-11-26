"""PySide6 local workbench for calibration-free horizontal disparity layers."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QImage, QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSlider,
    QSpinBox,
    QSplitter,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from .matching import (
    PairMatch,
    edge_trim_pixels,
    export_npz,
    match_pair,
    retention_mask,
    segment_disparity_layers,
    to_gray,
)
from .synthetic import make_two_layer_pair
from .visualization import (
    bgr_to_rgb,
    candidate_overlay,
    colorbar_rgb,
    colorize_disparity,
    cost_curve_rgb,
    layer_map,
    lr_heatmap,
    marker_overlay,
    reason_map,
    retention_split,
)


class ImageLabel(QLabel):
    """Aspect-fit image label that emits original-image pixel coordinates."""

    clicked = Signal(int, int)

    def __init__(self, placeholder: str = "载入图片", minimum: tuple[int, int] = (360, 260)) -> None:
        super().__init__(placeholder)
        self.setMinimumSize(*minimum)
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setStyleSheet("background:#1e1e20; color:#d8d8d8; border:1px solid #3a3a3d;")
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setMouseTracking(True)
        self._rgb: np.ndarray | None = None
        self._qimage: QImage | None = None
        self._pixmap: QPixmap | None = None

    def set_rgb(self, rgb: np.ndarray) -> None:
        self._rgb = np.ascontiguousarray(rgb)
        h, w = self._rgb.shape[:2]
        image = QImage(self._rgb.data, w, h, 3 * w, QImage.Format.Format_RGB888)
        self._qimage = image.copy()
        self._pixmap = QPixmap.fromImage(self._qimage)
        self._rescale()

    def resizeEvent(self, event) -> None:  # noqa: N802 - Qt API
        super().resizeEvent(event)
        self._rescale()

    def _rescale(self) -> None:
        if self._pixmap is None:
            return
        scaled = self._pixmap.scaled(
            self.contentsRect().size(),
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
        self.setPixmap(scaled)

    def mousePressEvent(self, event) -> None:  # noqa: N802 - Qt API
        if self._rgb is None or event.button() != Qt.MouseButton.LeftButton:
            super().mousePressEvent(event)
            return
        h, w = self._rgb.shape[:2]
        rect = self.contentsRect()
        scale = min(rect.width() / w, rect.height() / h)
        dw, dh = w * scale, h * scale
        x0 = rect.x() + (rect.width() - dw) / 2.0
        y0 = rect.y() + (rect.height() - dh) / 2.0
        pos = event.position()
        x = int(np.floor((pos.x() - x0) / scale))
        y = int(np.floor((pos.y() - y0) / scale))
        if 0 <= x < w and 0 <= y < h:
            self.clicked.emit(x, y)
        super().mousePressEvent(event)


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("横向视差分层工作台 — 无标定 / 同行对照")
        self.resize(1500, 940)

        self.images: dict[str, np.ndarray | None] = {"left": None, "right": None}
        self.paths: dict[str, str] = {"left": "", "right": ""}
        self.pair: PairMatch | None = None
        self.scene = None
        self.inspect_side = "left"
        self.click_xy: tuple[int, int] | None = None
        self.ui_masks: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]] = {}
        self.layer_data: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        self.current_main_rgb: np.ndarray | None = None

        self._build_ui()
        self.load_demo()

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        root = QSplitter(Qt.Orientation.Horizontal)
        self.setCentralWidget(root)

        root.addWidget(self._build_controls())
        root.addWidget(self._build_center())
        root.setStretchFactor(0, 0)
        root.setStretchFactor(1, 1)
        root.setSizes([350, 1120])

        self.statusBar().showMessage("就绪：点击主图位置，在右侧查看候选像素与双向匹配状态")

    def _build_controls(self) -> QWidget:
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setMinimumWidth(330)
        scroll.setMaximumWidth(430)
        box = QWidget()
        scroll.setWidget(box)
        layout = QVBoxLayout(box)
        layout.setSpacing(10)

        io_group = QGroupBox("1. 左右同排图片")
        io_layout = QGridLayout(io_group)
        self.btn_open_left = QPushButton("打开左图…")
        self.btn_open_right = QPushButton("打开右图…")
        self.btn_demo = QPushButton("生成前后两层示例")
        self.btn_edge_demo = QPushButton("生成触边两层示例")
        self.btn_swap = QPushButton("反转左右输入（搜索区间同时取反）")
        self.lbl_left_path = QLabel("未选择")
        self.lbl_right_path = QLabel("未选择")
        self.lbl_left_path.setWordWrap(True)
        self.lbl_right_path.setWordWrap(True)
        for label in (self.lbl_left_path, self.lbl_right_path):
            label.setStyleSheet("color:#b8b8c0; font-size:11px;")
        io_layout.addWidget(self.btn_open_left, 0, 0)
        io_layout.addWidget(self.btn_open_right, 0, 1)
        io_layout.addWidget(self.lbl_left_path, 1, 0)
        io_layout.addWidget(self.lbl_right_path, 1, 1)
        io_layout.addWidget(self.btn_demo, 2, 0, 1, 2)
        io_layout.addWidget(self.btn_edge_demo, 3, 0, 1, 2)
        io_layout.addWidget(self.btn_swap, 4, 0, 1, 2)
        layout.addWidget(io_group)

        match_group = QGroupBox("2. 横向搜索与可靠度")
        form = QFormLayout(match_group)
        self.spin_min = QSpinBox()
        self.spin_min.setRange(-512, 512)
        self.spin_min.setValue(0)
        self.spin_max = QSpinBox()
        self.spin_max.setRange(-512, 512)
        self.spin_max.setValue(48)
        range_row = QWidget()
        range_layout = QHBoxLayout(range_row)
        range_layout.setContentsMargins(0, 0, 0, 0)
        range_layout.addWidget(self.spin_min)
        range_layout.addWidget(QLabel("到"))
        range_layout.addWidget(self.spin_max)
        form.addRow(" signed d 范围", range_row)

        self.spin_radius = QSpinBox()
        self.spin_radius.setRange(1, 8)
        self.spin_radius.setValue(2)
        form.addRow("半窗半径", self.spin_radius)

        self.spin_lr = QDoubleSpinBox()
        self.spin_lr.setRange(0.1, 8.0)
        self.spin_lr.setSingleStep(0.1)
        self.spin_lr.setValue(1.2)
        form.addRow("左右分歧阈值 px", self.spin_lr)

        self.slider_conf = QSlider(Qt.Orientation.Horizontal)
        self.slider_conf.setRange(0, 90)
        self.slider_conf.setValue(15)
        self.lbl_conf_value = QLabel("15%")
        self.lbl_conf_value.setFixedWidth(42)
        conf_row = QWidget()
        conf_layout = QHBoxLayout(conf_row)
        conf_layout.setContentsMargins(0, 0, 0, 0)
        conf_layout.addWidget(self.slider_conf, 1)
        conf_layout.addWidget(self.lbl_conf_value)
        form.addRow("可靠度下限", conf_row)

        self.spin_texture = QDoubleSpinBox()
        self.spin_texture.setRange(0.0, 60.0)
        self.spin_texture.setSingleStep(0.5)
        self.spin_texture.setValue(4.0)
        form.addRow("低纹理梯度阈值", self.spin_texture)

        self.spin_trim = QSpinBox()
        self.spin_trim.setRange(0, 8)
        self.spin_trim.setValue(2)
        form.addRow("遮挡边修剪 px", self.spin_trim)

        self.chk_lr = QCheckBox("保留前启用左右互查")
        self.chk_lr.setChecked(True)
        self.chk_texture = QCheckBox("剔除低纹理块")
        self.chk_texture.setChecked(True)
        self.chk_repetitive = QCheckBox("额外剔除重复条纹候选")
        self.chk_range = QCheckBox("剔除搜索范围端点（越界嫌疑）")
        self.chk_border = QCheckBox("剔除图像触边块")
        self.chk_edge_guard = QCheckBox("启用强 Canny 边缘保护（较保守）")
        for chk in (
            self.chk_lr,
            self.chk_texture,
            self.chk_repetitive,
            self.chk_range,
            self.chk_border,
            self.chk_edge_guard,
        ):
            form.addRow(chk)

        self.btn_run = QPushButton("按当前范围/窗宽重新计算")
        self.btn_run.setStyleSheet("font-weight:600; padding:6px;")
        form.addRow(self.btn_run)
        layout.addWidget(match_group)

        view_group = QGroupBox("3. 查看")
        view_form = QFormLayout(view_group)
        self.combo_reference = QComboBox()
        self.combo_reference.addItem("左/第一幅为参考（d=xL-xR）", "left")
        self.combo_reference.addItem("右/第二幅为参考（d=xR-xL，符号为负）", "right")
        view_form.addRow("参考方向", self.combo_reference)

        self.combo_view = QComboBox()
        self.combo_view.addItem("彩色视差（原始估计）", "disp")
        self.combo_view.addItem("原始 / 可靠保留分屏", "split")
        self.combo_view.addItem("保留 / 无效区域与剔除原因", "reason")
        self.combo_view.addItem("远近分层（K-means）", "layers")
        self.combo_view.addItem("左右互相查找分歧", "lr")
        self.combo_view.addItem("左原图", "left")
        self.combo_view.addItem("右原图", "right")
        view_form.addRow("主图", self.combo_view)
        self.spin_layers = QSpinBox()
        self.spin_layers.setRange(2, 8)
        self.spin_layers.setValue(2)
        view_form.addRow("分层数", self.spin_layers)
        layout.addWidget(view_group)

        depth_group = QGroupBox("4. 可选比例深度 Z=K/|d|")
        depth_form = QFormLayout(depth_group)
        self.chk_depth = QCheckBox("换算实际深度")
        self.spin_k = QDoubleSpinBox()
        self.spin_k.setRange(0.0, 1.0e12)
        self.spin_k.setDecimals(2)
        self.spin_k.setValue(1000.0)
        self.spin_k.setEnabled(False)
        self.edit_unit = QLabel("mm（可在导出元数据中记录）")
        depth_form.addRow(self.chk_depth)
        depth_form.addRow("K=f·B 或比例常数", self.spin_k)
        depth_form.addRow("单位", self.edit_unit)
        layout.addWidget(depth_group)

        export_group = QGroupBox("5. 导出原始精度数据")
        export_layout = QVBoxLayout(export_group)
        self.btn_export_npz = QPushButton("导出 NPZ：float视差/深度/掩膜/方向…")
        self.btn_export_png = QPushButton("导出当前主视图 PNG…")
        export_layout.addWidget(self.btn_export_npz)
        export_layout.addWidget(self.btn_export_png)
        export_layout.addWidget(
            QLabel("NPZ 保留小数视差、geometry/reliable/invalid 掩膜和参考图方向；不会用 0 当无效值。")
        )
        layout.addWidget(export_group)

        legend = QGroupBox("图例")
        legend_layout = QVBoxLayout(legend)
        legend_label = QLabel(
            "彩色=有效视差；白色=视差恰好为 0；暗粉棋盘=无几何支持/无效。\n"
            "绿色=当前保留；橙色=左右分歧；品红=重复纹理；黄色=低纹理；\n"
            "青色=搜索端点；淡紫=遮挡边修剪。视差 0 与无效掩膜分开保存。"
        )
        legend_label.setWordWrap(True)
        legend_layout.addWidget(legend_label)
        layout.addWidget(legend)
        layout.addStretch(1)

        self.btn_open_left.clicked.connect(lambda: self.open_image("left"))
        self.btn_open_right.clicked.connect(lambda: self.open_image("right"))
        self.btn_demo.clicked.connect(lambda: self.load_demo(edge_touch=None))
        self.btn_edge_demo.clicked.connect(lambda: self.load_demo(edge_touch="left"))
        self.btn_swap.clicked.connect(self.swap_inputs)
        self.btn_run.clicked.connect(self.recompute)
        self.btn_export_npz.clicked.connect(self.export_npz)
        self.btn_export_png.clicked.connect(self.export_png)

        for widget in (
            self.spin_lr,
            self.slider_conf,
            self.spin_texture,
            self.spin_trim,
        ):
            if hasattr(widget, "valueChanged"):
                widget.valueChanged.connect(self.refresh_views)
        self.slider_conf.valueChanged.connect(lambda value: self.lbl_conf_value.setText(f"{value}%"))
        for chk in (
            self.chk_lr,
            self.chk_texture,
            self.chk_repetitive,
            self.chk_range,
            self.chk_border,
            self.chk_edge_guard,
        ):
            chk.toggled.connect(self.refresh_views)
        self.combo_reference.currentIndexChanged.connect(self.on_reference_changed)
        self.combo_view.currentIndexChanged.connect(self.refresh_views)
        self.spin_layers.valueChanged.connect(self.refresh_views)
        self.chk_depth.toggled.connect(self.spin_k.setEnabled)
        self.chk_depth.toggled.connect(self.refresh_views)
        self.spin_k.valueChanged.connect(self.refresh_views)

        return scroll

    def _build_center(self) -> QWidget:
        splitter = QSplitter(Qt.Orientation.Vertical)

        top = QWidget()
        top_layout = QHBoxLayout(top)
        top_layout.setContentsMargins(4, 4, 4, 4)
        self.main_label = ImageLabel("主视图：先计算视差", (520, 360))
        self.main_label.clicked.connect(self.on_main_click)
        self.colorbar_label = ImageLabel("", (28, 220))
        self.colorbar_label.setFixedWidth(54)
        top_layout.addWidget(self.main_label, 1)
        top_layout.addWidget(self.colorbar_label, 0)
        splitter.addWidget(top)

        bottom = QSplitter(Qt.Orientation.Horizontal)
        self.peer_label = ImageLabel("点击主图后，这里显示另一张图的候选像素", (420, 240))
        self.peer_label.clicked.connect(self.on_peer_click)
        bottom.addWidget(self.peer_label)

        inspector = QWidget()
        inspector_layout = QVBoxLayout(inspector)
        self.combo_peer = QComboBox()
        self.combo_peer.addItem("候选像素 + 匹配框", "candidate")
        self.combo_peer.addItem("对侧原图", "image")
        self.combo_peer.addItem("对侧左右分歧", "lr")
        self.combo_peer.currentIndexChanged.connect(self.refresh_peer)
        inspector_layout.addWidget(self.combo_peer)
        self.curve_label = ImageLabel("代价曲线", (360, 180))
        self.curve_label.setMinimumHeight(180)
        inspector_layout.addWidget(self.curve_label)
        self.info_text = QTextEdit()
        self.info_text.setReadOnly(True)
        self.info_text.setMinimumHeight(170)
        self.info_text.setStyleSheet("font-family: Menlo, Consolas, monospace; font-size:12px;")
        inspector_layout.addWidget(self.info_text, 1)
        bottom.addWidget(inspector)
        bottom.setStretchFactor(0, 3)
        bottom.setStretchFactor(1, 2)
        splitter.addWidget(bottom)
        splitter.setSizes([650, 270])
        return splitter

    # ------------------------------------------------------------------ IO
    def open_image(self, side: str) -> None:
        title = "打开左/第一幅图" if side == "left" else "打开右/第二幅图"
        path, _ = QFileDialog.getOpenFileName(
            self,
            title,
            "",
            "Images (*.png *.jpg *.jpeg *.bmp *.tif *.tiff *.webp *.pgm)",
        )
        if not path:
            return
        try:
            from .matching import load_image

            img = load_image(path)
        except Exception as exc:  # noqa: BLE001 - GUI boundary
            QMessageBox.critical(self, "读取失败", str(exc))
            return
        self.images[side] = img
        self.paths[side] = path
        label = self.lbl_left_path if side == "left" else self.lbl_right_path
        label.setText(Path(path).name)
        label.setToolTip(path)
        if self.images["left"] is not None and self.images["right"] is not None:
            if self.images["left"].shape[:2] != self.images["right"].shape[:2]:
                QMessageBox.warning(self, "尺寸不一致", "两张图片的高宽必须相同；请重新整理到同一行后再输入。")
                return
            self.scene = None
            self.recompute()

    def load_demo(self, edge_touch: str | None = None) -> None:
        self.scene = make_two_layer_pair(edge_touch=edge_touch)
        self.images["left"] = self.scene.left
        self.images["right"] = self.scene.right
        tag = "（触边）" if edge_touch else ""
        self.paths = {"left": f"<synthetic-left{tag}>", "right": f"<synthetic-right{tag}>"}
        self.lbl_left_path.setText(f"内置两层示例{tag}")
        self.lbl_right_path.setText("含低纹理块 + 重复条纹")
        self.spin_min.setValue(0)
        self.spin_max.setValue(self.scene.fg_disp + 8)
        self.spin_radius.setValue(2)
        self.inspect_side = "left"
        self.combo_reference.setCurrentIndex(0)
        self.click_xy = None
        self.recompute()

    def swap_inputs(self) -> None:
        if self.images["left"] is None or self.images["right"] is None:
            return
        self.images["left"], self.images["right"] = self.images["right"], self.images["left"]
        self.paths["left"], self.paths["right"] = self.paths["right"], self.paths["left"]
        self.lbl_left_path.setText(Path(self.paths["left"]).name if not self.paths["left"].startswith("<") else self.paths["left"])
        self.lbl_right_path.setText(Path(self.paths["right"]).name if not self.paths["right"].startswith("<") else self.paths["right"])
        lo, hi = self.spin_min.value(), self.spin_max.value()
        self.spin_min.setValue(-hi)
        self.spin_max.setValue(-lo)
        # The cached GT is indexed by the original left/right arrays; after a
        # manual slot reversal do not show it against the new slot order.
        self.scene = None
        ref = self.combo_reference.currentData()
        self.combo_reference.setCurrentIndex(1 if ref == "left" else 0)
        self.recompute()

    # ------------------------------------------------------------- matching
    def recompute(self) -> None:
        if self.images["left"] is None or self.images["right"] is None:
            return
        lo, hi = self.spin_min.value(), self.spin_max.value()
        if lo > hi:
            lo, hi = hi, lo
        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            self.pair = self._run_match(lo, hi)
            self.pair.reference_side = self.combo_reference.currentData()
            self.inspect_side = self.pair.reference_side
            self.click_xy = None
            self.refresh_views()
            self.statusBar().showMessage(
                f"完成：搜索 {lo}..{hi}，半窗 {self.spin_radius.value()}；点击主图检查候选",
                5000,
            )
        except Exception as exc:  # noqa: BLE001 - GUI boundary
            QMessageBox.critical(self, "计算失败", f"{type(exc).__name__}: {exc}")
        finally:
            QApplication.restoreOverrideCursor()

    def _run_match(self, lo: int, hi: int) -> PairMatch:
        left_gray = to_gray(self.images["left"])  # type: ignore[arg-type]
        right_gray = to_gray(self.images["right"])  # type: ignore[arg-type]
        return match_pair(
            left_gray,
            right_gray,
            min_disp=lo,
            max_disp=hi,
            radius=self.spin_radius.value(),
            lr_threshold=self.spin_lr.value(),
            texture_threshold=self.spin_texture.value(),
        )

    def on_reference_changed(self) -> None:
        side = self.combo_reference.currentData()
        if self.pair is not None:
            self.pair.reference_side = side
        self.inspect_side = side
        self.refresh_views()

    # ------------------------------------------------------------ rendering
    def _current_settings(self) -> dict[str, Any]:
        return {
            "confidence": self.slider_conf.value() / 100.0,
            "lr_threshold": self.spin_lr.value(),
            "require_lr": self.chk_lr.isChecked(),
            "reject_textureless": self.chk_texture.isChecked(),
            "reject_repetitive": self.chk_repetitive.isChecked(),
            "reject_range_edge": self.chk_range.isChecked(),
            "reject_border": self.chk_border.isChecked(),
            "reject_edge_guard": self.chk_edge_guard.isChecked(),
            "edge_trim": self.spin_trim.value(),
            "texture_threshold": self.spin_texture.value(),
        }

    def refresh_views(self) -> None:
        if self.pair is None:
            return
        settings = self._current_settings()
        self.pair.lr_threshold = settings["lr_threshold"]
        self.ui_masks = {}
        self.layer_data = {}
        for side, result in (("left", self.pair.left), ("right", self.pair.right)):
            result.lr_consistent = result.lr_diff <= settings["lr_threshold"]
            result.textureless_mask = result.texture_score < settings["texture_threshold"]
            pre_trim = retention_mask(
                result,
                confidence_threshold=settings["confidence"],
                lr_threshold=settings["lr_threshold"],
                require_lr=settings["require_lr"],
                reject_textureless=settings["reject_textureless"],
                reject_repetitive=settings["reject_repetitive"],
                reject_range_edge=settings["reject_range_edge"],
                reject_border=settings["reject_border"],
                reject_edge_guard=settings["reject_edge_guard"],
                edge_trim=0,
            )
            trim = edge_trim_pixels(pre_trim, settings["edge_trim"])
            kept = pre_trim & ~trim
            self.ui_masks[side] = (pre_trim, trim, kept)
            self.layer_data[side] = segment_disparity_layers(
                result.disparity, kept, self.spin_layers.value()
            )

        self.render_main()
        self.refresh_peer()

    def _side_for_main_view(self, view: str) -> str:
        if view == "left":
            return "left"
        if view == "right":
            return "right"
        return self.combo_reference.currentData()

    def render_main(self) -> None:
        if self.pair is None:
            return
        view = self.combo_view.currentData()
        side = self._side_for_main_view(view)
        result = self.pair.left if side == "left" else self.pair.right
        _, trim, kept = self.ui_masks[side]
        layer_labels, layer_centers = self.layer_data[side]

        if view == "left":
            rgb = bgr_to_rgb(self.images["left"])  # type: ignore[arg-type]
        elif view == "right":
            rgb = bgr_to_rgb(self.images["right"])  # type: ignore[arg-type]
        elif view == "disp":
            rgb = colorize_disparity(result)
        elif view == "split":
            rgb = retention_split(result, kept)
        elif view == "reason":
            rgb = reason_map(result, kept, trim)
        elif view == "layers":
            rgb = layer_map(layer_labels, layer_centers)
        elif view == "lr":
            rgb = lr_heatmap(result.lr_diff)
        else:
            rgb = bgr_to_rgb(self.images["left"])  # type: ignore[arg-type]

        if self.click_xy is not None and (view in ("disp", "split", "reason", "layers", "lr") or self.inspect_side == side):
            x, y = self.click_xy
            radius = self.spin_radius.value()
            positions = [x] if rgb.shape[1] == self.images[side].shape[1] else [x, x + self.images[side].shape[1]]  # type: ignore[union-attr]
            for px in positions:
                cv2.drawMarker(rgb, (px, y), (0, 255, 255), cv2.MARKER_CROSS, 20, 2)
                cv2.rectangle(rgb, (px - radius, y - radius), (px + radius, y + radius), (0, 255, 140), 1)

        self.current_main_rgb = rgb
        self.main_label.set_rgb(rgb)
        if view in ("disp", "split"):
            self.colorbar_label.setVisible(True)
            self.colorbar_label.set_rgb(
                colorbar_rgb(float(result.disparities.min()), float(result.disparities.max()))
            )
        else:
            self.colorbar_label.setVisible(False)

    def on_main_click(self, x: int, y: int) -> None:
        if self.pair is None or self.images["left"] is None:
            return
        base_w = self.images["left"].shape[1]
        view = self.combo_view.currentData()
        if view == "split" and x >= base_w:
            x -= base_w
        self.click_xy = (x, y)
        self.inspect_side = self._side_for_main_view(view)
        self.render_main()
        self.refresh_peer()

    def on_peer_click(self, x: int, y: int) -> None:
        if self.pair is None:
            return
        other = "right" if self.inspect_side == "left" else "left"
        self.inspect_side = other
        self.click_xy = (x, y)
        self.render_main()
        self.refresh_peer()

    def refresh_peer(self) -> None:
        if self.pair is None:
            return
        side = self.inspect_side
        other_side = "right" if side == "left" else "left"
        result = self.pair.left if side == "left" else self.pair.right
        other_result = self.pair.right if side == "left" else self.pair.left
        other_img = self.images[other_side]
        assert other_img is not None

        mode = self.combo_peer.currentData()
        if self.click_xy is None:
            self.peer_label.set_rgb(bgr_to_rgb(other_img))
            self.curve_label.setText("点击主图后显示代价曲线")
            self.info_text.setHtml("<p>点击主图任意像素。</p>")
            return

        x, y = self.click_xy
        if mode == "candidate":
            self.peer_label.set_rgb(candidate_overlay(other_img, x, y, result))
        elif mode == "image":
            self.peer_label.set_rgb(marker_overlay(other_img, x - int(round(result.disparity[y, x])) if result.geometry_mask[y, x] else x, y, self.spin_radius.value()))
        else:
            self.peer_label.set_rgb(lr_heatmap(other_result.lr_diff))

        costs = result.cost_volume[:, y, x]
        support = result.support_volume[:, y, x]
        best_i = int(np.argmin(np.where(support, costs, np.inf)))
        self.curve_label.set_rgb(
            cost_curve_rgb(result.disparities, costs, support, best_i, float(result.disparity[y, x]))
        )
        self._update_info(side, x, y)

    def _update_info(self, side: str, x: int, y: int) -> None:
        assert self.pair is not None
        result = self.pair.left if side == "left" else self.pair.right
        _, trim, kept = self.ui_masks[side]
        d = float(result.disparity[y, x])
        valid = bool(result.geometry_mask[y, x])
        is_kept = bool(kept[y, x])
        tx = x - d if np.isfinite(d) else np.nan
        depth = ""
        if self.chk_depth.isChecked() and self.spin_k.value() > 0 and np.isfinite(d):
            unit = self.edit_unit.text().split("（")[0]
            if abs(d) <= 1e-6:
                depth = "<br>深度 Z = ∞（零视差；通常表示无穷远/背景常数偏移）"
            else:
                depth = f"<br>深度 Z = {self.spin_k.value() / abs(d):.3f} {unit}"

        flags = []
        if not valid:
            flags.append("无完整候选/几何无效")
        if result.border_mask[y, x]:
            flags.append("图像触边")
        if result.range_edge_mask[y, x]:
            flags.append("搜索端点/可能超出范围")
        if result.textureless_mask[y, x]:
            flags.append("低纹理")
        if result.repetitive_mask[y, x]:
            flags.append("重复/多候选")
        if np.isfinite(result.lr_diff[y, x]):
            flags.append(f"LR分歧={result.lr_diff[y, x]:.2f}px")
        else:
            flags.append("LR无对侧候选")
        if trim[y, x]:
            flags.append("被遮挡边修剪")
        flag_text = "、".join(flags) if flags else "无"

        gt_line = ""
        if self.scene is not None:
            gt = (
                self.scene.ground_truth_disparity_left
                if side == "left"
                else self.scene.ground_truth_disparity_right_signed
            )
            gt_d = float(gt[y, x])
            err = abs(d - gt_d) if np.isfinite(d) else float("nan")
            gt_line = f"<br>验证 GT d={gt_d:.1f}, |误差|={err:.3f}px"

        zero_note = "（这是合法零视差，不是无效掩膜）" if valid and abs(d) < 1e-6 else ""
        layer_line = ""
        if side in self.layer_data:
            layer_labels, centers = self.layer_data[side]
            layer_id = int(layer_labels[y, x])
            if layer_id >= 0 and layer_id < len(centers):
                layer_line = f"<br><b>远近分层:</b> L{layer_id}（中心 |d|={abs(float(centers[layer_id])):.2f}，L0 最近）"
        self.info_text.setHtml(
            f"""
            <div style='font-size:13px'>
            <b>检查侧:</b> {side}　<b>坐标:</b> ({x}, {y})<br>
            <b>视差:</b> <span style='color:#0a7'>{d:.4f}</span> px {zero_note}<br>
            <b>候选位置:</b> x_target = {tx:.2f}, y={y}（同一扫描行）<br>
            <b>可靠保留:</b> <span style='color:{'#0a5' if is_kept else '#c43'}'>{is_kept}</span>
            <b>置信度:</b> {result.confidence[y, x]:.3f}
            <b>SAD:</b> {result.best_cost[y, x]:.2f}/{result.second_cost[y, x]:.2f}{depth}{layer_line}{gt_line}
            <hr><b>状态:</b> {flag_text}
            </div>
            """
        )

    # -------------------------------------------------------------- export
    def export_npz(self) -> None:
        if self.pair is None:
            return
        default = str(Path.cwd() / "disparity_layer_data.npz")
        path, _ = QFileDialog.getSaveFileName(self, "导出原始视差数据", default, "NumPy compressed (*.npz)")
        if not path:
            return
        side = self.combo_reference.currentData()
        self.pair.reference_side = side
        _, trim_mask, retained = self.ui_masks[side]
        layer_labels, layer_centers = self.layer_data.get(side, (None, None))
        k = self.spin_k.value() if self.chk_depth.isChecked() else None
        try:
            saved = export_npz(
                path,
                self.pair,
                retained,
                depth_coefficient=k,
                source_paths=(self.paths["left"], self.paths["right"]),
                trim_mask=trim_mask,
                settings=self._current_settings(),
                layer_labels=layer_labels,
                layer_centers=layer_centers,
            )
            QMessageBox.information(self, "导出完成", f"已无损导出：\n{saved}")
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "导出失败", f"{type(exc).__name__}: {exc}")

    def export_png(self) -> None:
        if self.current_main_rgb is None:
            return
        default = str(Path.cwd() / "disparity_view.png")
        path, _ = QFileDialog.getSaveFileName(self, "导出当前视图", default, "PNG (*.png)")
        if not path:
            return
        bgr = cv2.cvtColor(self.current_main_rgb, cv2.COLOR_RGB2BGR)
        ok, buf = cv2.imencode(Path(path).suffix or ".png", bgr)
        if not ok:
            QMessageBox.critical(self, "导出失败", "OpenCV 无法编码该图片。")
            return
        buf.tofile(path)
        self.statusBar().showMessage(f"已导出 {path}", 5000)


def main() -> int:
    app = QApplication.instance() or QApplication(sys.argv)
    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
