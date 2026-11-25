"""灯光通道重组检查窗口 (PySide6)。"""

from __future__ import annotations

import os

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtGui import QAction, QPixmap
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QFrame,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..channels import CHANNEL_LABELS, CHANNEL_ORDER, ChannelSet, LoadStatus
from ..composite import (
    DisplayParams,
    ParamState,
    TONEMAP_MODES,
    compute_composite,
    display_image,
    probe_pixel,
)
from ..example_scene import (
    PROBE_DIFFUSE_ONLY,
    PROBE_SPEC_HOT,
    PROBE_ZERO_BASE,
    build_example_scene,
)
from ..io_npy import (
    load_channels,
    load_params,
    save_channel_npy,
    save_params,
)
from ..io_png import write_png_rgb8
from .image_view import ImageView, make_checker_pixmap, rgb8_to_qimage

TONEMAP_LABELS = {
    "clip": "直接截断 clip",
    "reinhard": "Reinhard (默认)",
    "aces": "ACES filmic",
}


def _fmt_rgb(v: np.ndarray | None) -> str:
    if v is None:
        return "—"
    return f"({v[0]: .4f}, {v[1]: .4f}, {v[2]: .4f})"


def _fmt_rgb8(v: np.ndarray | None) -> str:
    if v is None:
        return "—"
    return f"({v[0]:3d}, {v[1]:3d}, {v[2]:3d})"


class ChannelRow:
    """一路通道的控件集合: 载入按钮/状态/倍率/独显。"""

    def __init__(self, name: str, on_recompute):
        self.name = name
        self.label = QLabel(CHANNEL_LABELS[name])
        self.label.setMinimumWidth(130)

        self.load_btn = QPushButton("载入 npy…")
        self.load_btn.setFixedWidth(96)

        self.status = QLabel("未载入")
        self.status.setStyleSheet("color: #b58a72;")
        self.status.setMinimumWidth(150)

        self.mult = QDoubleSpinBox()
        self.mult.setRange(0.0, 10.0)
        self.mult.setSingleStep(0.1)
        self.mult.setDecimals(3)
        self.mult.setValue(1.0)
        self.mult.setFixedWidth(92)
        self.mult.valueChanged.connect(on_recompute)

        self.solo = QCheckBox("独显")
        self.solo.stateChanged.connect(on_recompute)

    def add_to_grid(self, grid: QGridLayout, row: int):
        grid.addWidget(self.label, row, 0)
        grid.addWidget(self.load_btn, row, 1)
        grid.addWidget(self.status, row, 2)
        grid.addWidget(self.mult, row, 3)
        grid.addWidget(self.solo, row, 4)


class MainWindow(QMainWindow):
    def __init__(self, start_with_example: bool = False):
        super().__init__()
        self.setWindowTitle("灯光通道重组检查窗口 — 线性浮点管线")
        self.resize(1480, 940)

        self.channel_set = ChannelSet()
        self.params = ParamState()
        self.display = DisplayParams()
        self.paths: dict[str, str | None] = {n: None for n in CHANNEL_ORDER}
        self.result = None
        self._cursor: tuple[int, int] | None = None
        self._view_rgb8: np.ndarray | None = None

        self._build_ui()
        self._build_menu()

        if start_with_example:
            self.load_example()

    # ------------------------------------------------------------------ UI
    def _build_ui(self):
        splitter = QSplitter(Qt.Orientation.Horizontal)

        # ===== 左侧控制面板 =====
        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(8, 8, 8, 8)

        ch_group = QGroupBox("通道 (浮点 .npy, HxWx3 或灰度 HxW)")
        grid = QGridLayout()
        grid.addWidget(self._header("通道"), 0, 0)
        grid.addWidget(self._header("文件"), 0, 1)
        grid.addWidget(self._header("状态"), 0, 2)
        grid.addWidget(self._header("倍率"), 0, 3)
        grid.addWidget(self._header("开关"), 0, 4)
        self.rows: dict[str, ChannelRow] = {}
        for i, name in enumerate(CHANNEL_ORDER, start=1):
            row = ChannelRow(name, self._on_control_changed)
            row.load_btn.clicked.connect(
                lambda _=False, n=name: self._pick_channel_file(n))
            row.add_to_grid(grid, i)
            self.rows[name] = row
        ch_group.setLayout(grid)
        left_layout.addWidget(ch_group)

        quick = QHBoxLayout()
        btn_example = QPushButton("内置几何示例")
        btn_example.clicked.connect(self.load_example)
        btn_export_npy = QPushButton("导出示例 npy…")
        btn_export_npy.clicked.connect(self.export_example_npy)
        quick.addWidget(btn_example)
        quick.addWidget(btn_export_npy)
        left_layout.addLayout(quick)

        disp_group = QGroupBox("显示变换 (只作用于预览/导出, 不改线性数据)")
        form = QFormLayout()
        self.exposure = QDoubleSpinBox()
        self.exposure.setRange(-6.0, 6.0)
        self.exposure.setDecimals(2)
        self.exposure.setSingleStep(0.25)
        self.exposure.setSuffix(" EV")
        self.exposure.valueChanged.connect(self._on_control_changed)
        form.addRow("曝光:", self.exposure)

        self.tonemap = QComboBox()
        for mode in TONEMAP_MODES:
            self.tonemap.addItem(TONEMAP_LABELS[mode], mode)
        self.tonemap.setCurrentIndex(self.tonemap.findData("reinhard"))
        self.tonemap.currentIndexChanged.connect(self._on_control_changed)
        form.addRow("色调映射:", self.tonemap)

        self.preview_target = QComboBox()
        self.preview_target.addItem("合成结果", "composite")
        for name in CHANNEL_ORDER:
            self.preview_target.addItem(CHANNEL_LABELS[name], name)
        self.preview_target.currentIndexChanged.connect(self._refresh_view)
        form.addRow("预览目标:", self.preview_target)
        disp_group.setLayout(form)
        left_layout.addWidget(disp_group)

        # 数值统计: 合成前线性值 vs 屏幕值对照
        stat_group = QGroupBox("数值对照 (合成前线性浮点, 不截断)")
        self.stats = QTableWidget(0, 5)
        self.stats.setHorizontalHeaderLabels(
            ["通道", "参与", "原始 min", "原始 max", "缩放后 max"])
        self.stats.verticalHeader().setVisible(False)
        self.stats.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        for col, width in enumerate((110, 100, 95, 95, 100)):
            self.stats.setColumnWidth(col, width)
        stat_layout = QVBoxLayout()
        stat_layout.addWidget(self.stats)
        self.linear_summary = QLabel("—")
        self.linear_summary.setWordWrap(True)
        stat_layout.addWidget(self.linear_summary)
        stat_group.setLayout(stat_layout)
        left_layout.addWidget(stat_group, stretch=1)

        left_scroll = QScrollArea()
        left_scroll.setWidget(left)
        left_scroll.setWidgetResizable(True)
        left_scroll.setMinimumWidth(560)
        splitter.addWidget(left_scroll)

        # ===== 右侧: 横幅 + 预览 + 探针 =====
        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(8, 8, 8, 8)

        self.banner = QLabel("")
        self.banner.setWordWrap(True)
        self.banner.setFrameStyle(QFrame.Shape.StyledPanel)
        self.banner.setStyleSheet(
            "background:#3a2f20; color:#f0d9a8; padding:6px;")
        self.banner.hide()
        right_layout.addWidget(self.banner)

        self.view = ImageView()
        self.view.pixelHovered.connect(self._on_hover)
        self.view.pixelLeft.connect(self._on_leave)
        right_layout.addWidget(self.view, stretch=3)

        probe_group = QGroupBox("像素探针 (鼠标在预览上移动; 线性值如实显示, 含 >1 高光)")
        probe_layout = QVBoxLayout()
        coord_row = QHBoxLayout()
        self.coord_label = QLabel("坐标: —")
        coord_row.addWidget(self.coord_label)
        for label, point in (
            ("跳到: 底色为零点", PROBE_ZERO_BASE),
            ("镜面高光点", PROBE_SPEC_HOT),
            ("纯漫反射点", PROBE_DIFFUSE_ONLY),
        ):
            btn = QPushButton(label)
            btn.clicked.connect(
                lambda _=False, p=point: self._jump_probe(p))
            coord_row.addWidget(btn)
        coord_row.addStretch(1)
        probe_layout.addLayout(coord_row)

        self.probe_table = QTableWidget(0, 7)
        self.probe_table.setHorizontalHeaderLabels(
            ["通道", "状态", "原始线性值", "倍率", "缩放后值", "屏幕色 0-255",
             "色样"])
        self.probe_table.verticalHeader().setVisible(False)
        self.probe_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        for col, width in enumerate((100, 95, 150, 70, 150, 120, 60)):
            self.probe_table.setColumnWidth(col, width)
        probe_layout.addWidget(self.probe_table)

        self.total_label = QLabel("合成总值: —")
        self.total_label.setWordWrap(True)
        probe_layout.addWidget(self.total_label)
        probe_group.setLayout(probe_layout)
        right_layout.addWidget(probe_group, stretch=2)

        splitter.addWidget(right)
        splitter.setSizes([600, 880])
        self.setCentralWidget(splitter)
        self.statusBar().showMessage("就绪。建议先打开「内置几何示例」。")

    def _build_menu(self):
        mb = self.menuBar()
        m_file = mb.addMenu("文件")

        act_example = QAction("打开内置几何示例", self)
        act_example.triggered.connect(self.load_example)
        m_file.addAction(act_example)

        act_dir = QAction("从目录载入四通道 npy…", self)
        act_dir.triggered.connect(self.pick_directory)
        m_file.addAction(act_dir)

        m_file.addSeparator()
        act_save_png = QAction("导出合成成品 PNG…", self)
        act_save_png.triggered.connect(self.export_composite_png)
        m_file.addAction(act_save_png)

        act_save_preview = QAction("导出当前预览 PNG…", self)
        act_save_preview.triggered.connect(self.export_preview_png)
        m_file.addAction(act_save_preview)

        m_file.addSeparator()
        act_save_params = QAction("保存调整参数 JSON…", self)
        act_save_params.triggered.connect(self.save_params_file)
        m_file.addAction(act_save_params)

        act_load_params = QAction("载入参数 JSON (重开复现)…", self)
        act_load_params.triggered.connect(self.load_params_file)
        m_file.addAction(act_load_params)

    @staticmethod
    def _header(text: str) -> QLabel:
        lab = QLabel(text)
        lab.setStyleSheet("font-weight: bold;")
        return lab

    # ------------------------------------------------------------ 数据载入
    def _pick_channel_file(self, name: str):
        path, _ = QFileDialog.getOpenFileName(
            self, f"选择 {CHANNEL_LABELS[name]} 的 npy 文件",
            "", "NumPy 数组 (*.npy)")
        if not path:
            return
        self.paths[name] = path
        self._reload_all()

    def pick_directory(self):
        """按文件名包含 base/emission/diffuse/specular 自动识别。"""
        directory = QFileDialog.getExistingDirectory(self, "选择通道目录")
        if not directory:
            return
        found = {n: None for n in CHANNEL_ORDER}
        for fn in sorted(os.listdir(directory)):
            if not fn.endswith(".npy"):
                continue
            low = fn.lower()
            for name in CHANNEL_ORDER:
                if name in low and found[name] is None:
                    found[name] = os.path.join(directory, fn)
        if not any(found.values()):
            QMessageBox.warning(self, "未找到通道",
                                "目录里没有文件名含 "
                                "base/emission/diffuse/specular 的 npy。")
            return
        self.paths = found
        self._reload_all()

    def load_example(self):
        from ..channels import LoadedChannel
        scene = build_example_scene()
        self.channel_set = ChannelSet(channels={
            name: LoadedChannel(name, LoadStatus.OK, data=scene[name],
                                path="<内置示例>")
            for name in CHANNEL_ORDER
        })
        self.paths = {n: "<内置示例>" for n in CHANNEL_ORDER}
        self._sync_status_widgets()
        self._recompute()
        self.statusBar().showMessage(
            "已载入内置示例: 含底色为零点、纯漫反射点与 >1 镜面高光点。")

    def export_example_npy(self):
        directory = QFileDialog.getExistingDirectory(self, "导出示例 npy 到目录")
        if not directory:
            return
        scene = build_example_scene()
        for name, arr in scene.items():
            save_channel_npy(os.path.join(directory, f"{name}.npy"), arr)
        self.statusBar().showMessage(f"示例四通道 npy 已写入 {directory}")

    def _reload_all(self):
        self.channel_set = load_channels(self.paths)
        self._sync_status_widgets()
        self._recompute()

    def _sync_status_widgets(self):
        for name in CHANNEL_ORDER:
            ch = self.channel_set.get(name)
            row = self.rows[name]
            if ch is None or ch.status == LoadStatus.MISSING:
                row.status.setText("缺失 (按 0 参与, 不顶替)")
                row.status.setStyleSheet("color:#e08a7a;")
            elif ch.status == LoadStatus.SHAPE_MISMATCH:
                row.status.setText(f"尺寸不符: {ch.detail}")
                row.status.setStyleSheet("color:#e08a7a;")
            elif ch.status == LoadStatus.BAD_DATA:
                row.status.setText(f"数据错误: {ch.detail}")
                row.status.setStyleSheet("color:#e08a7a;")
            else:
                row.status.setText(ch.detail)
                row.status.setStyleSheet("color:#9ecb96;")

    # ------------------------------------------------------------ 合成刷新
    def _on_control_changed(self, *_):
        self._recompute()

    def _collect_params(self) -> ParamState:
        return ParamState(
            multipliers={n: self.rows[n].mult.value() for n in CHANNEL_ORDER},
            solo={n: self.rows[n].solo.isChecked() for n in CHANNEL_ORDER},
        )

    def _collect_display(self) -> DisplayParams:
        return DisplayParams(
            exposure_ev=self.exposure.value(),
            tonemap=self.tonemap.currentData(),
        )

    def _recompute(self):
        if self.channel_set.reference_shape is None:
            self.result = None
            self._view_rgb8 = None
            self.view.set_overlay_text("")
            self.view.set_pixmap(None)
            self._update_banner_no_data()
            self._update_stats(None)
            self._update_probe()
            return
        self.params = self._collect_params()
        self.display = self._collect_display()
        self.result = compute_composite(
            self.channel_set, self.params, self.display)
        self._update_banner()
        self._update_stats(self.result)
        self._refresh_view()
        self._update_probe()

    def _refresh_view(self):
        if self.result is None:
            self.view.set_pixmap(None)
            return
        target = self.preview_target.currentData()
        if target == "composite":
            rgb8 = self.result.srgb8
        else:
            ch = self.channel_set.get(target)
            if ch is None or not ch.available:
                # 缺失通道: 棋盘格明示, 绝不拿别的图顶替
                h, w = self.result.shape
                self._view_rgb8 = None
                self.view.set_overlay_text(
                    f"{CHANNEL_LABELS[target]} 无数据\n(缺失或尺寸不符, "
                    "未用其他通道顶替)")
                self.view.set_pixmap(make_checker_pixmap(w, h))
                self.statusBar().showMessage(
                    f"{CHANNEL_LABELS[target]} 缺失, 棋盘格区域无数据。")
                return
            rgb8 = display_image(self.result.contributions[target],
                                 self.display)
        self.view.set_overlay_text("")
        self._view_rgb8 = np.ascontiguousarray(rgb8)
        self.view.set_pixmap(QPixmap.fromImage(rgb8_to_qimage(rgb8)))

    def _update_banner_no_data(self):
        missing = [CHANNEL_LABELS[n] for n in CHANNEL_ORDER]
        self.banner.setText(
            "⚠ 当前没有任何可用通道, 无法预览。缺失: " + "、".join(missing))
        self.banner.show()

    def _update_banner(self):
        r = self.result
        if not r.missing:
            self.banner.hide()
            self.banner.setText("")
            return
        names = "、".join(CHANNEL_LABELS[n] for n in r.missing)
        h, w = r.shape
        parts = [f"⚠ 以下通道缺失或不可用, 已按 0 处理且未用其他图顶替: {names}。"]
        parts.append(f"当前可预览部分: 其余 {4 - len(r.missing)} 路, "
                     f"画布尺寸 {w}x{h}。")
        soloed = [CHANNEL_LABELS[n] for n, v in self.params.solo.items() if v]
        if soloed:
            parts.append("独显中: " + "、".join(soloed))
        self.banner.setText(" ".join(parts))
        self.banner.show()

    def _update_stats(self, result):
        self.stats.setRowCount(0)
        if result is None:
            self.linear_summary.setText("—")
            return
        for name in CHANNEL_ORDER:
            row = self.stats.rowCount()
            self.stats.insertRow(row)
            raw = result.raw[name]
            if raw is None:
                vals = ["缺失", "—", "—", "—"]
            else:
                vals = [
                    "是" if result.included[name] else "否(独显/关闭)",
                    f"{raw.min(): .4f}",
                    f"{raw.max(): .4f}",
                    f"{result.contributions[name].max(): .4f}",
                ]
            cells = [CHANNEL_LABELS[name], *vals]
            for c, text in enumerate(cells):
                self.stats.setItem(row, c, QTableWidgetItem(text))
        over = float(np.mean(result.linear > 1.0)) * 100.0
        self.linear_summary.setText(
            f"合成线性值: min={result.linear.min():.4f}  "
            f"max={result.linear.max():.4f}  "
            f"超过 1.0 的像素占 {over:.1f}% —— "
            f"这些值在线性阶段完整保留, 仅在显示链末端压缩。")

    # ------------------------------------------------------------ 探针
    def _on_hover(self, x: int, y: int):
        self._cursor = (x, y)
        self._update_probe()

    def _on_leave(self):
        self._cursor = None
        self._update_probe()

    def _jump_probe(self, point: tuple[int, int]):
        self._cursor = point
        self._update_probe()

    def _update_probe(self):
        self.probe_table.setRowCount(0)
        if self.result is None or self._cursor is None:
            self.coord_label.setText("坐标: —")
            self.total_label.setText("合成总值: —")
            return
        x, y = self._cursor
        report = probe_pixel(self.channel_set, self.params, self.display, x, y)
        if not report.inside:
            self.coord_label.setText("坐标: 超出图像范围")
            return
        self.coord_label.setText(f"坐标: (x={x}, y={y})")
        for name in CHANNEL_ORDER:
            info = report.rows[name]
            row = self.probe_table.rowCount()
            self.probe_table.insertRow(row)
            if not info["available"]:
                cells = [CHANNEL_LABELS[name], "缺失", "—", "—", "—", "—", ""]
            else:
                cells = [
                    CHANNEL_LABELS[name],
                    "参与" if info["included"] else "未参与(独显)",
                    _fmt_rgb(info["raw"]),
                    f"{info['multiplier']:.3f}",
                    _fmt_rgb(info["scaled"]),
                    _fmt_rgb8(info["screen8"]),
                    "",
                ]
            for c, text in enumerate(cells):
                self.probe_table.setItem(row, c, QTableWidgetItem(text))
            if info["available"]:
                swatch = QLabel()
                s8 = info["screen8"]
                swatch.setStyleSheet(
                    f"background: rgb({s8[0]},{s8[1]},{s8[2]}); "
                    "border:1px solid #555;")
                swatch.setFixedHeight(18)
                self.probe_table.setCellWidget(row, 6, swatch)

        self.total_label.setText(
            f"合成线性值(截断前): {_fmt_rgb(report.total_linear)}   "
            f"曝光后: {_fmt_rgb(report.total_exposed)}   "
            f"色调映射后[0,1]: {_fmt_rgb(report.total_tonemapped)}   "
            f"屏幕色: {_fmt_rgb8(report.total_screen8)}")

    # ------------------------------------------------------------ 导出
    def _ask_save(self, title: str, default_name: str, filt: str):
        path, _ = QFileDialog.getSaveFileName(
            self, title, default_name, filt)
        return path or None

    def export_composite_png(self):
        if self.result is None:
            QMessageBox.warning(self, "无数据", "没有可导出的合成结果。")
            return
        path = self._ask_save("导出合成成品 PNG", "composite.png",
                              "PNG 图像 (*.png)")
        if path:
            write_png_rgb8(path, self.result.srgb8)
            self.statusBar().showMessage(f"成品 PNG 已导出: {path}")

    def export_preview_png(self):
        if self._view_rgb8 is None:
            QMessageBox.warning(
                self, "无预览", "当前预览目标缺失 (棋盘格), 无真实像素可导出。")
            return
        path = self._ask_save("导出当前预览 PNG", "preview.png",
                              "PNG 图像 (*.png)")
        if path:
            write_png_rgb8(path, self._view_rgb8)
            self.statusBar().showMessage(f"预览 PNG 已导出: {path}")

    def save_params_file(self):
        if self.result is None:
            QMessageBox.warning(self, "无数据", "请先载入通道再保存参数。")
            return
        path = self._ask_save("保存调整参数", "light_params.json",
                              "JSON 参数 (*.json)")
        if not path:
            return
        save_params(path, self._collect_params(), self._collect_display(),
                    self.paths)
        self.statusBar().showMessage(f"参数已保存: {path}")

    def load_params_file(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "载入参数 JSON", "", "JSON 参数 (*.json)")
        if not path:
            return
        try:
            params, display, sources = load_params(path)
        except Exception as exc:
            QMessageBox.critical(self, "参数文件无效", str(exc))
            return
        # 恢复控件状态
        for name in CHANNEL_ORDER:
            self.rows[name].mult.blockSignals(True)
            self.rows[name].mult.setValue(params.multipliers[name])
            self.rows[name].mult.blockSignals(False)
            self.rows[name].solo.blockSignals(True)
            self.rows[name].solo.setChecked(params.solo[name])
            self.rows[name].solo.blockSignals(False)
        self.exposure.blockSignals(True)
        self.exposure.setValue(display.exposure_ev)
        self.exposure.blockSignals(False)
        idx = self.tonemap.findData(display.tonemap)
        self.tonemap.setCurrentIndex(max(idx, 0))

        # 若参数里带来源路径且文件存在, 重新载入同一批 npy 以保证逐像素复现
        usable = {k: v for k, v in sources.items()
                  if v and os.path.isfile(v)}
        if usable:
            merged = dict(self.paths)
            merged.update(usable)
            self.paths = merged
            self._reload_all()
        else:
            self._recompute()
        self.statusBar().showMessage(
            f"参数已载入: {path}。合成结果与保存时一致 (同一 npy 输入下)。")
