"""主窗口：三图对照、参数调整、探针、控制点拟合、裁切与导出。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import numpy as np
import cv2
from PySide6.QtCore import Qt
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (
    QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QSplitter, QGroupBox,
    QPushButton, QLabel, QDoubleSpinBox, QSpinBox, QRadioButton, QButtonGroup,
    QCheckBox, QFileDialog, QMessageBox, QTableWidget, QTableWidgetItem,
    QHeaderView, QScrollArea, QGridLayout,
)

from .distortion import (
    DistortionParams, SPIN_RANGES,
    build_undistort_map, remap_image, project_pixels, unproject_pixels,
    check_stability, norm_scale,
)
from .gridgen import make_sample, default_sample_params, GridMeta
from .fitting import fit_distortion, FitResult
from .cropping import (
    valid_bounding_rect, largest_all_valid_rect,
    CropRect, crop_info_text,
)
from .export import (
    export_corrected_image, export_record, build_record,
    control_point_records,
)
from .widgets import ImageCanvas, MovablePointItem

# 与 matplotlib tab10 一致的控制点配色
POINT_COLORS = [
    (0.12, 0.47, 0.71), (1.00, 0.50, 0.05), (0.17, 0.63, 0.17),
    (0.84, 0.15, 0.16), (0.58, 0.40, 0.74), (0.55, 0.34, 0.29),
    (0.90, 0.62, 0.18), (0.49, 0.49, 0.49), (0.74, 0.41, 0.65),
    (0.10, 0.74, 0.74), (0.12, 0.47, 0.71), (1.00, 0.50, 0.05),
]


def qcolor(i: int) -> QColor:
    r, g, b = POINT_COLORS[i % len(POINT_COLORS)]
    return QColor(int(r * 255), int(g * 255), int(b * 255))


def hexcolor(i: int) -> str:
    r, g, b = POINT_COLORS[i % len(POINT_COLORS)]
    return f"#{int(r * 255):02x}{int(g * 255):02x}{int(b * 255):02x}"


@dataclass
class ControlPoint:
    index: int
    target: np.ndarray     # 参考网格上的理想位置 (u,v)
    observed: np.ndarray   # 畸变图上的观测位置 (u,v)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("镜头畸变校正工具（静态图片）")
        self.resize(1500, 900)

        # ---- 应用状态 ----
        self.ref_image: np.ndarray | None = None
        self.dist_image: np.ndarray | None = None
        self.corrected_image: np.ndarray | None = None
        self.valid_mask: np.ndarray | None = None
        self.dist_valid_mask: np.ndarray | None = None
        self.grid_meta: GridMeta | None = None
        self.params = DistortionParams()
        self.true_params: DistortionParams | None = None  # 样例真实参数
        self.source_name = ""
        self.is_sample = True
        self.control_points: list[ControlPoint] = []
        self.point_items_obs: list[MovablePointItem] = []
        self.point_items_tgt: list[MovablePointItem] = []
        self.fit_preview: FitResult | None = None
        self.params_before_fit: DistortionParams | None = None
        self.stability_warning = ""
        self._syncing_points = False
        self._updating_spins = False
        self._probing = False
        self.probe_data: dict | None = None
        self.bbox_rect: CropRect | None = None
        self.crop_rect: CropRect | None = None

        self._build_ui()
        self.load_default_sample()

    # ==================================================================
    # UI 构建
    # ==================================================================
    def _build_ui(self):
        central = QWidget()
        root = QHBoxLayout(central)
        splitter = QSplitter(Qt.Orientation.Horizontal)
        root.addWidget(splitter)

        splitter.addWidget(self._build_control_panel())
        splitter.addWidget(self._build_view_area())
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([380, 1120])
        self.setCentralWidget(central)
        self.statusBar().showMessage("就绪")

    def _build_view_area(self) -> QWidget:
        box = QWidget()
        layout = QVBoxLayout(box)
        view_split = QSplitter(Qt.Orientation.Horizontal)

        self.canvas_ref = ImageCanvas("ref", "原图 / 参考网格（理想像素坐标）")
        self.canvas_dist = ImageCanvas("dist", "带畸变图（可拖控制点 / 取探针）")
        self.canvas_corr = ImageCanvas("corr", "校正结果（红=越界无效，蓝框=裁切）")
        for c in (self.canvas_ref, self.canvas_dist, self.canvas_corr):
            c.attach_probe_click()
            c.probe_clicked.connect(self.on_canvas_probe_click)
            view_split.addWidget(c)
        view_split.setSizes([440, 440, 440])
        layout.addWidget(view_split)

        zoom_row = QHBoxLayout()
        for c in (self.canvas_ref, self.canvas_dist, self.canvas_corr):
            btn = QPushButton(f"自适应：{c.title_label.text().split('（')[0]}")
            btn.clicked.connect(c.fit_in_view)
            zoom_row.addWidget(btn)
        layout.addLayout(zoom_row)
        return box

    def _build_control_panel(self) -> QWidget:
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        panel = QWidget()
        panel.setMinimumWidth(340)
        v = QVBoxLayout(panel)

        v.addWidget(self._build_sample_group())
        v.addWidget(self._build_params_group())
        v.addWidget(self._build_probe_group())
        v.addWidget(self._build_fit_group())
        v.addWidget(self._build_crop_group())
        v.addWidget(self._build_export_group())
        v.addStretch(1)

        scroll.setWidget(panel)
        return scroll

    def _build_sample_group(self) -> QGroupBox:
        box = QGroupBox("1. 图像来源（全部本地生成/打开）")
        g = QGridLayout(box)
        self.btn_sample = QPushButton("恢复默认样例")
        self.btn_sample.clicked.connect(self.load_default_sample)
        self.btn_gen = QPushButton("按尺寸生成新样例")
        self.btn_gen.clicked.connect(self.generate_new_sample)
        self.btn_open = QPushButton("打开本地图片…")
        self.btn_open.clicked.connect(self.open_image)
        self.spin_w = QSpinBox()
        self.spin_w.setRange(160, 4000)
        self.spin_w.setValue(640)
        self.spin_h = QSpinBox()
        self.spin_h.setRange(160, 4000)
        self.spin_h.setValue(480)
        g.addWidget(QLabel("宽"), 0, 0)
        g.addWidget(self.spin_w, 0, 1)
        g.addWidget(QLabel("高"), 0, 2)
        g.addWidget(self.spin_h, 0, 3)
        g.addWidget(self.btn_gen, 1, 0, 1, 2)
        g.addWidget(self.btn_sample, 1, 2, 1, 2)
        g.addWidget(self.btn_open, 2, 0, 1, 4)
        self.lbl_source = QLabel("")
        self.lbl_source.setWordWrap(True)
        g.addWidget(self.lbl_source, 3, 0, 1, 4)
        self.lbl_true_params = QLabel("")
        self.lbl_true_params.setWordWrap(True)
        g.addWidget(self.lbl_true_params, 4, 0, 1, 4)
        return box

    def _make_param_spin(self, name: str) -> QDoubleSpinBox:
        lo, hi = SPIN_RANGES[name]
        spin = QDoubleSpinBox()
        spin.setRange(lo, hi)
        spin.setDecimals(4)
        spin.setSingleStep(0.005)
        spin.valueChanged.connect(lambda _v: self.on_params_edited())
        return spin

    def _build_params_group(self) -> QGroupBox:
        box = QGroupBox("2. 畸变参数（固定模型，正/反向共用）")
        g = QGridLayout(box)
        self.spin_k1 = self._make_param_spin("k1")
        self.spin_k2 = self._make_param_spin("k2")
        self.spin_p1 = self._make_param_spin("p1")
        self.spin_p2 = self._make_param_spin("p2")
        self.spin_cx = QDoubleSpinBox()
        self.spin_cy = QDoubleSpinBox()
        for sp in (self.spin_cx, self.spin_cy):
            sp.setDecimals(2)
            sp.setSingleStep(1.0)
            sp.setRange(0.0, 99999.0)
            sp.valueChanged.connect(lambda _v: self.on_params_edited())
        rows = [
            ("k1 径向", self.spin_k1, "无量纲；<0 桶形，>0 枕形"),
            ("k2 径向", self.spin_k2, "无量纲；高阶径向项"),
            ("p1 偏心", self.spin_p1, "无量纲；竖直方向偏心"),
            ("p2 偏心", self.spin_p2, "无量纲；水平方向偏心"),
            ("cx (px)", self.spin_cx, "畸变中心 u，像素"),
            ("cy (px)", self.spin_cy, "畸变中心 v，像素"),
        ]
        for r, (label, spin, note) in enumerate(rows):
            g.addWidget(QLabel(label), r, 0)
            g.addWidget(spin, r, 1)
            note_lbl = QLabel(note)
            note_lbl.setStyleSheet("color:#666;")
            g.addWidget(note_lbl, r, 2)
        self.btn_center = QPushButton("中心复位为画幅中心")
        self.btn_center.clicked.connect(self.reset_center)
        g.addWidget(self.btn_center, len(rows), 0, 1, 3)
        self.lbl_coord_note = QLabel(
            "归一化坐标 x=(u-cx)/s, y=(v-cy)/s；s=画幅半对角线(px)，"
            "角点 r≈1；零参数为恒等映射。")
        self.lbl_coord_note.setWordWrap(True)
        self.lbl_coord_note.setStyleSheet("color:#666;")
        g.addWidget(self.lbl_coord_note, len(rows) + 1, 0, 1, 3)
        return box

    def _build_probe_group(self) -> QGroupBox:
        box = QGroupBox("3. 单点坐标探针（正向/反向同套参数）")
        g = QVBoxLayout(box)
        self.btn_probe = QPushButton("开启探针：在原图或畸变图上取点")
        self.btn_probe.setCheckable(True)
        self.btn_probe.toggled.connect(self.toggle_probe)
        g.addWidget(self.btn_probe)
        self.btn_clear_probe = QPushButton("清除探针标记")
        self.btn_clear_probe.clicked.connect(self.clear_probe)
        g.addWidget(self.btn_clear_probe)
        self.lbl_probe = QLabel("未取点。取点后显示原始/畸变/还原坐标与往返偏差。")
        self.lbl_probe.setWordWrap(True)
        g.addWidget(self.lbl_probe)
        return box

    def _build_fit_group(self) -> QGroupBox:
        box = QGroupBox("4. 控制点拟合（中心固定，4~12 点）")
        g = QGridLayout(box)

        g.addWidget(QLabel("控制点数"), 0, 0)
        self.spin_npoints = QSpinBox()
        self.spin_npoints.setRange(4, 12)
        self.spin_npoints.setValue(6)
        self.spin_npoints.valueChanged.connect(self.on_npoints_changed)
        g.addWidget(self.spin_npoints, 0, 1)
        self.chk_snap = QCheckBox("拖动时吸附网格交点")
        self.chk_snap.setChecked(True)
        g.addWidget(self.chk_snap, 0, 2)

        self.rb_radial = QRadioButton("仅拟合 k1,k2")
        self.rb_full = QRadioButton("拟合 k1,k2,p1,p2")
        self.rb_radial.setChecked(True)
        # 显式独立互斥组，避免与裁切组的单选按钮因同属一个父窗口
        # 而被 Qt 的自动互斥机制合并
        fit_mode_group = QButtonGroup(box)
        fit_mode_group.setExclusive(True)
        fit_mode_group.addButton(self.rb_radial)
        fit_mode_group.addButton(self.rb_full)
        g.addWidget(self.rb_radial, 1, 0, 1, 2)
        g.addWidget(self.rb_full, 1, 2)

        self.btn_fit = QPushButton("执行拟合（预览，不立即应用）")
        self.btn_fit.clicked.connect(self.run_fit)
        g.addWidget(self.btn_fit, 2, 0, 1, 3)
        self.btn_apply = QPushButton("应用拟合参数")
        self.btn_apply.setEnabled(False)
        self.btn_apply.clicked.connect(self.apply_fit)
        self.btn_revert = QPushButton("撤回到拟合前")
        self.btn_revert.setEnabled(False)
        self.btn_revert.clicked.connect(self.revert_fit)
        g.addWidget(self.btn_apply, 3, 0, 1, 2)
        g.addWidget(self.btn_revert, 3, 2)

        self.tbl_resid = QTableWidget(0, 4)
        self.tbl_resid.setHorizontalHeaderLabels(
            ["点", "Δu (px)", "Δv (px)", "|残差| (px)"])
        self.tbl_resid.horizontalHeader().setSectionResizeMode(
            QHeaderView.ResizeMode.Stretch)
        self.tbl_resid.setMaximumHeight(170)
        g.addWidget(self.tbl_resid, 4, 0, 1, 3)
        self.lbl_fit = QLabel("拖动畸变图上的圆点改观测点；"
                              "参考图上的圆点为希望恢复的目标位置。")
        self.lbl_fit.setWordWrap(True)
        g.addWidget(self.lbl_fit, 5, 0, 1, 3)
        return box

    def _build_crop_group(self) -> QGroupBox:
        box = QGroupBox("5. 有效区域与裁切")
        g = QVBoxLayout(box)
        self.rb_keep_full = QRadioButton(
            "保留完整画幅（越界像素标红/导出填黑）")
        self.rb_crop = QRadioButton("裁去无效边缘（最大全有效矩形）")
        self.rb_keep_full.setChecked(True)
        crop_mode_group = QButtonGroup(box)
        crop_mode_group.setExclusive(True)
        crop_mode_group.addButton(self.rb_keep_full)
        crop_mode_group.addButton(self.rb_crop)
        self.rb_keep_full.toggled.connect(self.refresh_corrected_view)
        g.addWidget(self.rb_keep_full)
        g.addWidget(self.rb_crop)
        self.lbl_crop = QLabel("")
        self.lbl_crop.setWordWrap(True)
        g.addWidget(self.lbl_crop)
        self.lbl_stability = QLabel("")
        self.lbl_stability.setWordWrap(True)
        g.addWidget(self.lbl_stability)
        return box

    def _build_export_group(self) -> QGroupBox:
        box = QGroupBox("6. 导出（真实像素，不含界面边框）")
        g = QVBoxLayout(box)
        self.btn_export = QPushButton("导出校正图 PNG + 参数/控制点 JSON…")
        self.btn_export.clicked.connect(self.export_files)
        g.addWidget(self.btn_export)
        return box

    # ==================================================================
    # 图像加载与状态初始化
    # ==================================================================
    def load_default_sample(self):
        sample = make_sample()
        self._adopt_sample(sample, "程序生成样例（默认 640x480，已知真实参数）")
        self.true_params = sample.params.copy()
        # 样例先从零参数开始，让用户手动/拟合恢复到真实参数
        self.set_params(DistortionParams(
            cx=sample.shape[1] / 2.0, cy=sample.shape[0] / 2.0))
        self._reset_control_points_to_truth()
        self.statusBar().showMessage("已载入默认样例：可直接执行拟合核对真实参数")

    def generate_new_sample(self):
        w, h = int(self.spin_w.value()), int(self.spin_h.value())
        params = default_sample_params(w, h)
        sample = make_sample(w, h, params=params)
        self._adopt_sample(
            sample, f"程序生成样例 {w}x{h}（已知真实参数）")
        self.true_params = params.copy()
        self.set_params(DistortionParams(cx=w / 2.0, cy=h / 2.0))
        self._reset_control_points_to_truth()

    def _adopt_sample(self, sample, source_text: str):
        self.is_sample = True
        self.source_name = "generated_sample"
        self.ref_image = sample.ref_image
        self.dist_image = sample.dist_image
        self.dist_valid_mask = sample.valid_mask
        self.grid_meta = sample.meta
        h, w = sample.shape
        self.spin_cx.setRange(0.0, float(w))
        self.spin_cy.setRange(0.0, float(h))
        self.lbl_source.setText(
            f"{source_text}\n尺寸：{w} x {h} px")
        self.lbl_true_params.setText(
            "真实参数：" + self._format_params(sample.params))
        self.fit_preview = None
        self.params_before_fit = None
        self.btn_apply.setEnabled(False)
        self.btn_revert.setEnabled(False)
        self.clear_probe_markers()
        self._rebuild_point_items()
        self.refresh_all_views()

    def open_image(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "打开本地静态图片", "",
            "图片 (*.png *.jpg *.jpeg *.bmp *.tif *.tiff)")
        if not path:
            return
        data = np.fromfile(path, dtype=np.uint8)
        img = cv2.imdecode(data, cv2.IMREAD_COLOR)
        if img is None:
            QMessageBox.warning(self, "打开失败", f"无法读取图片：\n{path}")
            return
        h, w = img.shape[:2]
        self.is_sample = False
        self.source_name = Path(path).name
        self.ref_image = img
        self.dist_image = img.copy()
        self.dist_valid_mask = np.ones((h, w), dtype=bool)
        self.grid_meta = None
        self.true_params = None
        self.spin_cx.setRange(0.0, float(w))
        self.spin_cy.setRange(0.0, float(h))
        self.lbl_source.setText(
            f"本地图片：{self.source_name}\n尺寸：{w} x {h} px\n"
            "原图与带畸变图初始相同，请自行设置参数或放置控制点")
        self.lbl_true_params.setText("外部图片无已知真实参数可核对")
        self.set_params(DistortionParams(cx=w / 2.0, cy=h / 2.0))
        self.fit_preview = None
        self.params_before_fit = None
        self.btn_apply.setEnabled(False)
        self.btn_revert.setEnabled(False)
        self.clear_probe_markers()
        self._rebuild_point_items()
        self.refresh_all_views()
        self.statusBar().showMessage(f"已打开 {self.source_name}")

    # ==================================================================
    # 参数控件
    # ==================================================================
    @staticmethod
    def _format_params(p: DistortionParams) -> str:
        return (f"k1={p.k1:+.4f}, k2={p.k2:+.4f}, "
                f"p1={p.p1:+.4f}, p2={p.p2:+.4f}, "
                f"cx={p.cx:.2f}, cy={p.cy:.2f}")

    def set_params(self, p: DistortionParams):
        self.params = p.copy()
        self._sync_spins()
        self.refresh_all_views()

    def _sync_spins(self):
        self._updating_spins = True
        try:
            self.spin_k1.setValue(self.params.k1)
            self.spin_k2.setValue(self.params.k2)
            self.spin_p1.setValue(self.params.p1)
            self.spin_p2.setValue(self.params.p2)
            self.spin_cx.setValue(self.params.cx)
            self.spin_cy.setValue(self.params.cy)
        finally:
            self._updating_spins = False

    def on_params_edited(self):
        if self._updating_spins or self.ref_image is None:
            return
        # 手动改参数后，未应用的拟合预览作废
        self._invalidate_fit_preview()
        self.params = DistortionParams(
            k1=self.spin_k1.value(), k2=self.spin_k2.value(),
            p1=self.spin_p1.value(), p2=self.spin_p2.value(),
            cx=self.spin_cx.value(), cy=self.spin_cy.value())
        self.refresh_all_views()

    def reset_center(self):
        if self.ref_image is None:
            return
        h, w = self.ref_image.shape[:2]
        self.spin_cx.setValue(w / 2.0)
        self.spin_cy.setValue(h / 2.0)

    # ==================================================================
    # 视图刷新
    # ==================================================================
    def refresh_all_views(self):
        if self.ref_image is None:
            return
        self.canvas_ref.set_image(self.ref_image)
        self.canvas_dist.set_image(self.dist_image)
        self._recompute_corrected()
        self._sync_point_items_to_state()
        self._redraw_probe()

    def _recompute_corrected(self):
        shape = self.ref_image.shape[:2]
        report = check_stability(shape, self.params)
        self.stability_warning = report.message
        map_xy = build_undistort_map(shape, self.params)
        self.corrected_image = remap_image(self.ref_image, map_xy)
        self.valid_mask = (
            (map_xy[..., 0] >= 0.5)
            & (map_xy[..., 0] <= shape[1] - 1.5)
            & (map_xy[..., 1] >= 0.5)
            & (map_xy[..., 1] <= shape[0] - 1.5))
        self.bbox_rect = valid_bounding_rect(self.valid_mask)
        self.crop_rect = largest_all_valid_rect(self.valid_mask)
        self._update_stability_label(report.ok)
        self.refresh_corrected_view()
        self._update_crop_label()

    def refresh_corrected_view(self):
        if self.corrected_image is None:
            return
        view = self.corrected_image.copy()
        # 越界区域标红（仅显示用，导出按掩膜填黑）
        red = np.zeros_like(view)
        red[..., 2] = 255
        view = np.where(self.valid_mask[..., None], view,
                        cv2.addWeighted(view, 0.25, red, 0.75, 0))
        # 有效区外接矩形（黄）与实际裁切矩形（蓝）
        if self.bbox_rect is not None:
            b = self.bbox_rect
            cv2.rectangle(view, (b.x, b.y), (b.right - 1, b.bottom - 1),
                          (0, 200, 200), 1)
        if self.rb_crop.isChecked() and self.crop_rect is not None:
            c = self.crop_rect
            cv2.rectangle(view, (c.x, c.y), (c.right - 1, c.bottom - 1),
                          (220, 60, 0), 2)
        self.canvas_corr.set_image(view, keep_zoom=True)
        self._update_crop_label()

    def _update_stability_label(self, ok: bool):
        if ok:
            self.lbl_stability.setText("✓ 当前参数可稳定反向映射")
            self.lbl_stability.setStyleSheet("color:#1a7f37;")
        else:
            self.lbl_stability.setText(
                "⚠ 稳定性警告：" + self.stability_warning
                + "。该组合不能保证反向映射可靠，导出/校正结果不应当作成功")
            self.lbl_stability.setStyleSheet("color:#c0392b;")

    def _update_crop_label(self):
        if self.valid_mask is None:
            return
        ratio = float(np.mean(self.valid_mask)) * 100.0
        lines = [f"有效像素占比：{ratio:.1f}%"]
        lines.append("有效区外接矩形：" + crop_info_text(self.bbox_rect))
        if self.crop_rect is None:
            lines.append("最大全有效矩形：不存在（参数过强）")
        else:
            lines.append("裁切矩形（全有效）：" + crop_info_text(self.crop_rect))
        self.lbl_crop.setText("\n".join(lines))

    # ==================================================================
    # 控制点
    # ==================================================================
    def _default_fractions(self, n: int) -> list[tuple[float, float]]:
        """以画幅中心为圆心、多半径多角度的分散布局（归一化半径
        约 0.25~0.75），保证径向/偏心参数都有足够的可观测性。"""
        presets = [
            (0.50, 0.22), (0.78, 0.32), (0.80, 0.62), (0.62, 0.80),
            (0.38, 0.78), (0.22, 0.60), (0.20, 0.36), (0.34, 0.20),
            (0.50, 0.50), (0.66, 0.50), (0.50, 0.34), (0.34, 0.50),
        ]
        return presets[:n]

    def _rebuild_point_items(self):
        """加载新图或改变点数时重建控制点。"""
        for item in self.point_items_obs:
            self.canvas_dist.remove_item(item)
        for item in self.point_items_tgt:
            self.canvas_ref.remove_item(item)
        self.point_items_obs.clear()
        self.point_items_tgt.clear()
        self.control_points.clear()
        if self.ref_image is None:
            return
        h, w = self.ref_image.shape[:2]
        n = int(self.spin_npoints.value())
        for i, (fx, fy) in enumerate(self._default_fractions(n)):
            target = np.array([fx * w, fy * h], dtype=np.float64)
            observed = target.copy()
            self.control_points.append(ControlPoint(i, target, observed))
            obs_item = MovablePointItem(
                i, qcolor(i), on_move=self._on_observed_moved,
                snap=self._snap_point)
            tgt_item = MovablePointItem(
                i, qcolor(i), on_move=self._on_target_moved,
                snap=self._snap_point)
            self.point_items_obs.append(obs_item)
            self.point_items_tgt.append(tgt_item)
            self.canvas_dist.add_movable_point(obs_item)
            self.canvas_ref.add_movable_point(tgt_item)

    def on_npoints_changed(self, _value=None):
        if self.ref_image is None:
            return
        self._rebuild_point_items()
        # 样例自动按真实参数生成观测点；外部图片观测点=目标点
        if self.is_sample and self.true_params is not None:
            self._reset_control_points_to_truth()
        self._sync_point_items_to_state()
        self.tbl_resid.setRowCount(0)

    def _reset_control_points_to_truth(self):
        """样例：目标点取网格交点，观测点按真实参数正向生成。"""
        if self.ref_image is None or self.true_params is None:
            return
        h, w = self.ref_image.shape[:2]
        shape = (h, w)
        for i, cp in enumerate(self.control_points):
            target = cp.target.copy()
            if self.grid_meta is not None:
                inter = self.grid_meta.intersections()
                d = np.linalg.norm(inter - target, axis=1)
                target = inter[int(np.argmin(d))].copy()
            cp.target = target
            cp.observed = project_pixels(
                target.reshape(1, 2), shape, self.true_params)[0]
        self._sync_point_items_to_state()

    def _snap_point(self, qpoint):
        from PySide6.QtCore import QPointF
        if not self.chk_snap.isChecked() or self.grid_meta is None:
            return qpoint
        inter = self.grid_meta.intersections()
        d = np.hypot(inter[:, 0] - qpoint.x(), inter[:, 1] - qpoint.y())
        j = int(np.argmin(d))
        if d[j] <= self.grid_meta.spacing * 0.5:
            return QPointF(float(inter[j, 0]), float(inter[j, 1]))
        return qpoint

    def _on_observed_moved(self, idx: int, x: float, y: float):
        if self._syncing_points:
            return
        self._invalidate_fit_preview()
        self.control_points[idx].observed = np.array([x, y])

    def _on_target_moved(self, idx: int, x: float, y: float):
        if self._syncing_points:
            return
        self._invalidate_fit_preview()
        self.control_points[idx].target = np.array([x, y])

    def _sync_point_items_to_state(self):
        self._syncing_points = True
        try:
            for i, cp in enumerate(self.control_points):
                if i < len(self.point_items_obs):
                    self.point_items_obs[i].set_position_silent(
                        cp.observed[0], cp.observed[1])
                    self.point_items_tgt[i].set_position_silent(
                        cp.target[0], cp.target[1])
        finally:
            self._syncing_points = False

    # ==================================================================
    # 探针
    # ==================================================================
    def toggle_probe(self, on: bool):
        self._probing = on
        for c in (self.canvas_ref, self.canvas_dist, self.canvas_corr):
            c.set_probe_mode(on)
        if not on:
            self.btn_probe.setText("开启探针：在原图或畸变图上取点")
        else:
            self.btn_probe.setText("探针开启中… 点击画布取点（再点关闭）")

    def clear_probe(self):
        self.probe_data = None
        self.clear_probe_markers()
        self.lbl_probe.setText("已清除。")

    def clear_probe_markers(self):
        for c in (self.canvas_ref, self.canvas_dist, self.canvas_corr):
            c.clear_probes()

    def on_canvas_probe_click(self, canvas_name: str, u: float, v: float):
        if self.ref_image is None:
            return
        shape = self.ref_image.shape[:2]
        if canvas_name == "dist":
            # 在畸变图取点：已知畸变坐标，反推理想坐标
            dist_pt = np.array([[u, v]])
            ideal, conv = unproject_pixels(dist_pt, shape, self.params)
            ideal_pt = ideal[0]
            back = project_pixels(ideal_pt.reshape(1, 2), shape,
                                  self.params)[0]
            self.probe_data = {
                "kind": "dist",
                "original": ideal_pt, "distorted": np.array([u, v]),
                "restored": ideal_pt, "back": back,
                "converged": bool(conv[0])}
        else:
            # 在原图（或校正图）取点：已知理想坐标，正向求畸变坐标
            orig = np.array([u, v])
            dist_pt = project_pixels(orig.reshape(1, 2), shape,
                                     self.params)[0]
            ideal, conv = unproject_pixels(
                dist_pt.reshape(1, 2), shape, self.params)
            self.probe_data = {
                "kind": "ref",
                "original": orig, "distorted": dist_pt,
                "restored": ideal[0], "back": orig,
                "converged": bool(conv[0])}
        self._redraw_probe()

    def _redraw_probe(self):
        self.clear_probe_markers()
        d = self.probe_data
        if d is None:
            return
        o, dist, rest = d["original"], d["distorted"], d["restored"]
        # 真正的往返偏差：原始 -> 畸变 -> 还原，应回到原始点
        roundtrip = float(np.linalg.norm(rest - o))
        # 正向位移量（仅展示，不是误差）
        forward_shift = float(np.linalg.norm(dist - o))
        # 原图：原始点（蓝）与还原点（绿，正常重合）
        self.canvas_ref.add_probe(o[0], o[1], "#1f77b4", "原始")
        self.canvas_ref.add_probe(rest[0], rest[1], "#2ca02c", "还原")
        # 畸变图：畸变点（红）
        self.canvas_dist.add_probe(dist[0], dist[1], "#d62728", "畸变")
        # 校正图：与原图相同的原始/还原点
        self.canvas_corr.add_probe(o[0], o[1], "#1f77b4", "原始")
        self.canvas_corr.add_probe(rest[0], rest[1], "#2ca02c", "还原")
        conv_note = "" if d["converged"] else "  ⚠ 反投未收敛！"
        self.lbl_probe.setText(
            f"原始 (u,v) = ({o[0]:.2f}, {o[1]:.2f}) px\n"
            f"畸变 (u,v) = ({dist[0]:.2f}, {dist[1]:.2f}) px\n"
            f"还原 (u,v) = ({rest[0]:.2f}, {rest[1]:.2f}) px\n"
            f"正向位移 |畸变-原始| = {forward_shift:.3f} px\n"
            f"往返偏差 |原始→畸变→还原| = {roundtrip:.3e} px{conv_note}")

    # ==================================================================
    # 拟合
    # ==================================================================
    def _invalidate_fit_preview(self):
        self.fit_preview = None
        self.btn_apply.setEnabled(False)

    def run_fit(self):
        if self.ref_image is None:
            return
        shape = self.ref_image.shape[:2]
        mode = "radial" if self.rb_radial.isChecked() else "full"
        targets = np.array([cp.target for cp in self.control_points])
        observed = np.array([cp.observed for cp in self.control_points])
        result = fit_distortion(
            targets, observed, shape,
            center=(self.params.cx, self.params.cy), mode=mode)
        if not result.ok:
            # 拟合失败：保留已有图像与参数
            QMessageBox.warning(self, "拟合失败", result.message)
            self.lbl_fit.setText("拟合失败：" + result.message
                                 + "（现有图像与参数保持不变）")
            self.statusBar().showMessage("拟合失败，未改动任何参数")
            return

        # 预览：暂存候选参数并刷新视图，不覆盖当前参数
        self.params_before_fit = self.params.copy()
        self.fit_preview = result
        self.btn_apply.setEnabled(True)
        self.btn_revert.setEnabled(True)
        self.params = result.params.copy()
        self._sync_spins()
        self.refresh_all_views()
        self._fill_residual_table(result)
        self.lbl_fit.setText("预览中：" + result.message
                             + "。可「应用」或「撤回到拟合前」")
        self.statusBar().showMessage(result.message)

    def _fill_residual_table(self, result: FitResult):
        n = len(self.control_points)
        self.tbl_resid.setRowCount(n)
        for i in range(n):
            du, dv = result.residuals_px[i]
            items = [
                QTableWidgetItem(f"{i + 1}"),
                QTableWidgetItem(f"{du:+.3f}"),
                QTableWidgetItem(f"{dv:+.3f}"),
                QTableWidgetItem(f"{result.distances_px[i]:.3f}"),
            ]
            for col, item in enumerate(items):
                if col > 0:
                    item.setTextAlignment(
                        Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
                self.tbl_resid.setItem(i, col, item)

    def apply_fit(self):
        if self.fit_preview is None:
            return
        # 当前 self.params 已经是预览参数，确认保留即可
        self.fit_preview = None
        self.btn_apply.setEnabled(False)
        self.lbl_fit.setText("已应用拟合参数。仍可「撤回到拟合前」。")
        self.statusBar().showMessage("拟合参数已应用")

    def revert_fit(self):
        if self.params_before_fit is None:
            return
        self.params = self.params_before_fit.copy()
        self.params_before_fit = None
        self.fit_preview = None
        self.btn_apply.setEnabled(False)
        self.btn_revert.setEnabled(False)
        self._sync_spins()
        self.refresh_all_views()
        self.tbl_resid.setRowCount(0)
        self.lbl_fit.setText("已撤回到拟合前的参数与图像。")
        self.statusBar().showMessage("已撤回拟合")

    # ==================================================================
    # 导出
    # ==================================================================
    def export_files(self):
        if self.corrected_image is None:
            return
        if not self.params.within_supported() or self.stability_warning:
            ret = QMessageBox.warning(
                self, "参数稳定性警告",
                "当前参数存在稳定性问题：\n" + self.stability_warning
                + "\n\n仍要导出吗？结果可能包含不可靠像素。",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No)
            if ret != QMessageBox.StandardButton.Yes:
                return

        crop_mode = "crop" if self.rb_crop.isChecked() else "full"
        crop = self.crop_rect if crop_mode == "crop" else None
        if crop_mode == "crop" and crop is None:
            QMessageBox.warning(
                self, "无法裁切",
                "不存在全有效的裁切矩形，请改用完整画幅或调整参数。")
            return

        directory = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not directory:
            return
        out_dir = Path(directory)
        stem = Path(self.source_name).stem or "image"
        suffix = "_cropped" if crop_mode == "crop" else "_full"
        png_path = out_dir / f"{stem}_corrected{suffix}.png"
        json_path = out_dir / f"{stem}_record{suffix}.json"

        w, h = export_corrected_image(
            png_path, self.corrected_image, self.valid_mask, crop, crop_mode)

        residual_dist = (self.fit_preview.distances_px
                         if self.fit_preview is not None else None)
        fit_summary = None
        if self.fit_preview is not None:
            r = self.fit_preview
            fit_summary = {
                "rmse_px": r.rmse_px, "max_err_px": r.max_err_px,
                "iterations": r.iterations,
                "mode": "radial" if self.rb_radial.isChecked() else "full",
            }
        record = build_record(
            source_name=self.source_name,
            source_size=(self.ref_image.shape[1], self.ref_image.shape[0]),
            params=self.params,
            norm_s=norm_scale(self.ref_image.shape[:2]),
            control_points=control_point_records(
                self.control_points, residual_dist),
            fit_mode="radial" if self.rb_radial.isChecked() else "full",
            fit_summary=fit_summary,
            crop_mode=crop_mode, crop=crop, export_size=(w, h))
        export_record(json_path, record)
        self.statusBar().showMessage(
            f"已导出 {png_path.name}（{w}x{h}）与 {json_path.name}")
        QMessageBox.information(
            self, "导出完成",
            f"图像：{png_path}\n记录：{json_path}\n输出尺寸：{w} x {h} px")
