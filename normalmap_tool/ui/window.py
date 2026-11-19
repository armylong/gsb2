"""Main window: parameters, synchronised views, pixel readout, export/reload.

Two modes share one lighting path:

* ``generated`` — height map -> normals -> stored bytes.  Toggling the green
  convention re-encodes the bytes, so the geometry and the lighting do not
  change; only the stored G bytes do.
* ``loaded`` — an existing normal PNG is read numerically.  The bytes are
  fixed, so toggling the green convention re-decodes them.  This is the mode
  used to confirm an exported map.

All lighting is computed on the *decoded stored bytes*, which is why the
readout, the material preview and a reloaded file agree.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtGui import QAction, QColor, QPalette
from PySide6.QtWidgets import (
    QApplication,
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
    QSizePolicy,
    QStatusBar,
    QVBoxLayout,
    QWidget,
)

from ..io import (
    ImageLoadError,
    light_from_meta,
    load_height_png,
    load_normal_png,
    save_normal_png,
)
from ..model import (
    BOUNDARIES,
    DecodedNormals,
    BOUNDARY_EXTEND,
    BOUNDARY_LABELS,
    BOUNDARY_WRAP,
    GREEN_LABELS,
    GREEN_Y_DOWN,
    GREEN_Y_UP,
    LightSettings,
    decode_normal_rgb,
    grey_uint8,
    light_direction_at,
    light_direction_field,
    shade,
)
from ..pipeline import BuildParams, NormalBuild, build_normals
from ..presets import (
    PRESETS,
    PRESET_ORDER,
    PRESET_WAVE,
    VALIDATION_LIGHT,
    expected_normal_for_ramp,
    expected_normal_wave,
    fixed_lamp_intensity,
    generate_preset,
    preset_defaults,
    wave_tolerance,
)
from .canvas import CanvasBox

ZOOM_LEVELS = (0, 1, 2, 4, 8)
MODE_GENERATED = "generated"
MODE_LOADED = "loaded"


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("法线贴图工作台 — 高度 → 法线 → 光照核对")
        self.resize(1520, 980)

        self.mode = MODE_GENERATED
        self.height: Optional[np.ndarray] = None
        self.codes: Optional[np.ndarray] = None
        self.bit_depth = 8
        self.height_label = "未载入"
        self.source_path: Optional[str] = None
        self.active_preset: Optional[str] = None

        self.build: Optional[NormalBuild] = None
        self.loaded_rgb: Optional[np.ndarray] = None
        self.loaded_meta: dict = {}
        self.loaded_path: Optional[str] = None

        self.rgb: Optional[np.ndarray] = None
        self.decoded = None
        self.lit: Optional[np.ndarray] = None
        self.flat_lit: Optional[np.ndarray] = None
        self.light_vectors: Optional[np.ndarray] = None

        self.selection = (0, 0)
        self._markers_enabled = True

        self._build_ui()
        self._build_actions()
        self._wire()
        self._apply_theme()
        self._set_mode(MODE_GENERATED)
        self._refresh_all()

    # ------------------------------------------------------------------ UI --
    def _build_ui(self) -> None:
        central = QWidget(self)
        root = QHBoxLayout(central)
        root.setContentsMargins(10, 10, 10, 10)
        root.setSpacing(10)
        root.addWidget(self._make_sidebar(), 0)

        right = QVBoxLayout()
        right.setSpacing(8)
        self.canvas_height = CanvasBox(
            "① 原始高度", "height",
            "载入的灰度 PNG; 越亮越高。显示映射与窗口缩放无关。")
        self.canvas_processed = CanvasBox(
            "② 处理后高度", "processed",
            "预平滑后的高度; 只参与法线计算, 不修改原始文件。")
        self.canvas_normal = CanvasBox(
            "③ 法线贴图 (RGB)", "normal",
            "R→nx, G→ny, B→nz; 分量 −1..1 映射到 0..255。")
        self.canvas_material = CanvasBox(
            "④ 材质光照预览", "material",
            "点击/拖动选像素; 拖动黄色灯标记移动灯光。缩放只影响显示。")
        self.canvas_flat = CanvasBox(
            "⑤ 平坦对照", "flat",
            "同一灯光作用于 n=(0,0,1) 的平坦材质, 用于判断凹凸方向。")

        grid = QGridLayout()
        grid.setSpacing(8)
        grid.addWidget(self.canvas_height, 0, 0)
        grid.addWidget(self.canvas_processed, 0, 1)
        grid.addWidget(self.canvas_normal, 0, 2)
        grid.addWidget(self.canvas_material, 1, 0, 1, 2)
        grid.addWidget(self.canvas_flat, 1, 2)
        for c in range(3):
            grid.setColumnStretch(c, 1)
        grid.setRowStretch(0, 3)
        grid.setRowStretch(1, 4)

        right.addLayout(grid, 1)
        right.addWidget(self._make_readout())
        root.addLayout(right, 1)
        self.setCentralWidget(central)
        self.setStatusBar(QStatusBar(self))

    def _make_sidebar(self) -> QWidget:
        panel = QWidget()
        panel.setObjectName("sidebar")
        panel.setFixedWidth(372)
        lay = QVBoxLayout(panel)
        lay.setContentsMargins(0, 0, 0, 8)
        lay.setSpacing(10)

        src = QGroupBox("高度图来源")
        src_l = QVBoxLayout(src)
        self.lbl_mode = QLabel("模式: 高度生成")
        self.lbl_mode.setObjectName("modeBadge")
        src_l.addWidget(self.lbl_mode)
        row = QHBoxLayout()
        self.btn_open = QPushButton("载入高度 PNG…")
        self.btn_open.setObjectName("primary")
        row.addWidget(self.btn_open)
        self.btn_back_to_height = QPushButton("返回生成模式")
        row.addWidget(self.btn_back_to_height)
        src_l.addLayout(row)
        self.lbl_source = QLabel("未载入")
        self.lbl_source.setObjectName("muted")
        self.lbl_source.setWordWrap(True)
        src_l.addWidget(self.lbl_source)
        src_l.addWidget(self._divider())
        preset_row = QHBoxLayout()
        self.combo_preset = QComboBox()
        for key in PRESET_ORDER:
            self.combo_preset.addItem(PRESETS[key].label, key)
        preset_row.addWidget(self.combo_preset, 1)
        self.btn_preset = QPushButton("载入预设")
        preset_row.addWidget(self.btn_preset)
        src_l.addLayout(preset_row)
        lay.addWidget(src)

        params = QGroupBox("法线参数")
        params_box = QVBoxLayout(params)
        params_box.setContentsMargins(8, 4, 8, 8)
        params_box.setSpacing(4)
        form = QFormLayout()
        form.setLabelAlignment(Qt.AlignLeft)
        form.setFieldGrowthPolicy(QFormLayout.AllNonFixedFieldsGrow)

        self.spin_strength = self._spin(0.0, 256.0, 1.0, 2, " px")
        self.spin_strength.setToolTip(
            "高度强度: 全高度范围 (0..1) 对应的 z 位移, 以像素为单位。\n"
            "0 表示完全平坦。坡度为 强度 × 高度对像素的导数。")
        form.addRow("高度强度", self.spin_strength)

        self.spin_smooth = self._spin(0.0, 32.0, 0.1, 2, " σ")
        self.spin_smooth.setToolTip("预平滑的高斯标准差 (像素); 0 = 不平滑。")
        form.addRow("预平滑", self.spin_smooth)

        self.combo_green = QComboBox()
        for key in (GREEN_Y_UP, GREEN_Y_DOWN):
            self.combo_green.addItem(GREEN_LABELS[key], key)
        form.addRow("绿色通道", self.combo_green)

        self.combo_boundary = QComboBox()
        for key in (BOUNDARY_EXTEND, BOUNDARY_WRAP):
            self.combo_boundary.addItem(BOUNDARY_LABELS[key], key)
        form.addRow("边界", self.combo_boundary)
        params_box.addLayout(form)
        self.lbl_green_hint = self._hint()
        params_box.addWidget(self.lbl_green_hint)
        self.lbl_boundary_hint = self._hint()
        params_box.addWidget(self.lbl_boundary_hint)
        lay.addWidget(params)

        light = QGroupBox("灯光 (平面预览)")
        light_box = QVBoxLayout(light)
        light_box.setContentsMargins(8, 4, 8, 8)
        light_box.setSpacing(4)
        lform = QFormLayout()
        lform.setLabelAlignment(Qt.AlignLeft)
        lform.setFieldGrowthPolicy(QFormLayout.AllNonFixedFieldsGrow)
        self.spin_lx = self._spin(-1.0, 1.0, 0.01, 3, " X")
        self.spin_ly = self._spin(-1.0, 1.0, 0.01, 3, " Y")
        self.spin_lh = self._spin(0.05, 4.0, 0.05, 3, " ×S")
        self.spin_lh.setToolTip("灯光高度, 以平面半对角线 S 为单位。")
        self.spin_ambient = self._spin(0.0, 1.0, 0.01, 3, "")
        self.spin_diffuse = self._spin(0.0, 1.0, 0.01, 3, "")
        lform.addRow("灯光平面 X", self.spin_lx)
        lform.addRow("灯光平面 Y", self.spin_ly)
        lform.addRow("灯光高度", self.spin_lh)
        lform.addRow("环境光", self.spin_ambient)
        lform.addRow("漫反射", self.spin_diffuse)
        light_box.addLayout(lform)
        self.lbl_light_hint = self._hint()
        light_box.addWidget(self.lbl_light_hint)
        lay.addWidget(light)

        view = QGroupBox("视图")
        v_l = QVBoxLayout(view)
        zrow = QHBoxLayout()
        zrow.addWidget(QLabel("缩放"))
        self.combo_zoom = QComboBox()
        for z in ZOOM_LEVELS:
            self.combo_zoom.addItem("适应窗口" if z == 0 else f"{z}× 像素", z)
        zrow.addWidget(self.combo_zoom, 1)
        v_l.addLayout(zrow)
        self.chk_markers = QCheckBox("显示同步标记与方向箭头")
        self.chk_markers.setChecked(True)
        v_l.addWidget(self.chk_markers)
        lay.addWidget(view)

        exp = QGroupBox("导出与回读")
        e_l = QVBoxLayout(exp)
        self.btn_export = QPushButton("导出法线 PNG + 参数记录…")
        self.btn_export.setObjectName("primary")
        e_l.addWidget(self.btn_export)
        self.btn_load_normal = QPushButton("载入法线 PNG 做光照核对…")
        e_l.addWidget(self.btn_load_normal)
        note = self._hint()
        note.setText("导出会写同名 .png.json: 坐标约定、绿色通道、边界、强度、"
                     "预平滑与校验灯光。回读按数值读取字节。")
        e_l.addWidget(note)
        lay.addWidget(exp)

        chk = QGroupBox("预设校验")
        c_l = QVBoxLayout(chk)
        self.lbl_check = QLabel("")
        self.lbl_check.setObjectName("readout")
        self.lbl_check.setWordWrap(True)
        self.lbl_check.setTextInteractionFlags(Qt.TextSelectableByMouse)
        c_l.addWidget(self.lbl_check)
        lay.addWidget(chk)

        lay.addStretch(1)
        return panel

    @staticmethod
    def _spin(lo, hi, step, decimals, suffix) -> QDoubleSpinBox:
        s = QDoubleSpinBox()
        s.setRange(lo, hi)
        s.setSingleStep(step)
        s.setDecimals(decimals)
        s.setSuffix(suffix)
        s.setKeyboardTracking(False)
        return s

    @staticmethod
    def _hint() -> QLabel:
        label = QLabel("")
        label.setObjectName("muted")
        label.setWordWrap(True)
        return label

    @staticmethod
    def _divider() -> QFrame:
        line = QFrame()
        line.setFrameShape(QFrame.HLine)
        line.setObjectName("divider")
        return line

    def _make_readout(self) -> QWidget:
        box = QGroupBox("像素读数")
        box.setMinimumHeight(130)
        lay = QHBoxLayout(box)
        self.lbl_readout = QLabel("—")
        self.lbl_readout.setObjectName("readout")
        self.lbl_readout.setTextFormat(Qt.RichText)
        self.lbl_readout.setAlignment(Qt.AlignLeft | Qt.AlignTop)
        self.lbl_readout.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.lbl_readout.setMinimumWidth(420)
        self.lbl_readout.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.MinimumExpanding)
        lay.addWidget(self.lbl_readout, 1)
        return box

    def _build_actions(self) -> None:
        menu = self.menuBar().addMenu("文件")
        for text, shortcut, slot in (
            ("载入高度 PNG…", "Ctrl+O", self.open_height),
            ("导出法线…", "Ctrl+E", self.export_normal),
            ("载入法线核对…", "Ctrl+Shift+O", self.load_normal_for_check),
        ):
            act = QAction(text, self)
            act.setShortcut(shortcut)
            act.triggered.connect(slot)
            menu.addAction(act)
        menu.addSeparator()
        quit_act = QAction("退出", self)
        quit_act.setShortcut("Ctrl+Q")
        quit_act.triggered.connect(self.close)
        menu.addAction(quit_act)
        help_menu = self.menuBar().addMenu("帮助")
        about = QAction("坐标与操作说明", self)
        about.triggered.connect(self.show_help)
        help_menu.addAction(about)

    def _wire(self) -> None:
        self.btn_open.clicked.connect(self.open_height)
        self.btn_preset.clicked.connect(self.load_selected_preset)
        self.btn_export.clicked.connect(self.export_normal)
        self.btn_load_normal.clicked.connect(self.load_normal_for_check)
        self.btn_back_to_height.clicked.connect(self._return_to_height)
        for w in (self.spin_strength, self.spin_smooth):
            w.valueChanged.connect(self._on_param_changed)
        self.combo_green.currentIndexChanged.connect(self._on_param_changed)
        self.combo_boundary.currentIndexChanged.connect(self._on_param_changed)
        for w in (self.spin_lx, self.spin_ly, self.spin_lh,
                  self.spin_ambient, self.spin_diffuse):
            w.valueChanged.connect(self._on_light_changed)
        self.combo_zoom.currentIndexChanged.connect(self._on_zoom_changed)
        self.chk_markers.toggled.connect(self._on_markers_toggled)
        for cb in self.all_canvases():
            cb.canvas.pixelPicked.connect(self.on_pixel_picked)
        self.canvas_material.canvas.lightMoved.connect(self.on_light_dragged)
        self.combo_preset.currentIndexChanged.connect(self._update_preset_check)

    def all_canvases(self):
        return (self.canvas_height, self.canvas_processed, self.canvas_normal,
                self.canvas_material, self.canvas_flat)

    # ------------------------------------------------------------- theme --
    def _apply_theme(self) -> None:
        self.setStyleSheet(
            """
            QMainWindow, QWidget { background: #14151a; color: #e6e7ec; }
            #sidebar { background: #191a20; }
            QGroupBox {
                background: #1d1e25; border: 1px solid #2c2e38;
                border-radius: 8px; margin-top: 14px; padding-top: 8px;
                font-weight: 600;
            }
            QGroupBox::title {
                subcontrol-origin: margin; left: 12px; padding: 0 4px;
                color: #aab0c2;
            }
            QLabel#muted { color: #8a8f9f; font-size: 11px; font-weight: normal; }
            QLabel#readout { color: #d9dbe4; font-size: 12px; font-weight: normal; }
            QLabel#modeBadge {
                background: #22304f; color: #9db6ff; border-radius: 5px;
                padding: 4px 8px; font-size: 11px; font-weight: 600;
            }
            QLabel#canvasTitle { color: #cfd3df; font-weight: 600; }
            QLabel#canvasCaption { color: #878c9b; font-size: 11px; }
            #canvasBox { background: #1a1b21; border: 1px solid #2b2d37;
                         border-radius: 8px; }
            QPushButton {
                background: #262835; border: 1px solid #383b4a;
                border-radius: 6px; padding: 6px 10px; font-weight: normal;
            }
            QPushButton:hover { background: #2e3140; }
            QPushButton:disabled { color: #666a78; }
            QPushButton#primary {
                background: #3b5bd6; border-color: #4d6df0; font-weight: 600;
            }
            QPushButton#primary:hover { background: #4a6aea; }
            QPushButton#primary:disabled {
                background: #242834; border-color: #2f3444; color: #5f6678;
            }
            QComboBox, QDoubleSpinBox {
                background: #23252f; border: 1px solid #383b4a;
                border-radius: 5px; padding: 3px 6px; min-height: 20px;
                font-weight: normal;
            }
            QComboBox QAbstractItemView {
                background: #23252f; selection-background-color: #3b5bd6;
            }
            QScrollArea { background: transparent; }
            QFrame#divider { color: #2c2e38; }
            QStatusBar { color: #8a8f9f; }
            QMenuBar, QMenu { background: #1a1b21; }
            QMenuBar::item:selected, QMenu::item:selected { background: #2e3140; }
            """
        )

    # -------------------------------------------------------------- state --
    @property
    def params(self) -> BuildParams:
        return BuildParams(
            strength=float(self.spin_strength.value()),
            smoothing=float(self.spin_smooth.value()),
            boundary=str(self.combo_boundary.currentData()),
            green=str(self.combo_green.currentData()),
        )

    @property
    def light(self) -> LightSettings:
        return LightSettings(
            plane_x=float(self.spin_lx.value()),
            plane_y=float(self.spin_ly.value()),
            height=float(self.spin_lh.value()),
            ambient=float(self.spin_ambient.value()),
            diffuse=float(self.spin_diffuse.value()),
        ).clamped()

    def _set_light_controls(self, light: LightSettings) -> None:
        pairs = (
            (self.spin_lx, light.plane_x),
            (self.spin_ly, light.plane_y),
            (self.spin_lh, light.height),
            (self.spin_ambient, light.ambient),
            (self.spin_diffuse, light.diffuse),
        )
        for widget, value in pairs:
            widget.blockSignals(True)
            widget.setValue(value)
            widget.blockSignals(False)

    def _set_mode(self, mode: str) -> None:
        self.mode = mode
        generated = mode == MODE_GENERATED
        if generated:
            self.lbl_mode.setText("模式: 高度生成 · 绿色切换只改变存储")
        else:
            self.lbl_mode.setText("模式: 法线回读 · 绿色切换重新解释存储")
        self.spin_strength.setEnabled(generated)
        self.spin_smooth.setEnabled(generated)
        self.combo_boundary.setEnabled(generated)
        self.btn_export.setEnabled(generated)
        self.btn_back_to_height.setVisible(not generated)
        self.btn_preset.setEnabled(generated)
        self.btn_open.setEnabled(True)

    # ------------------------------------------------------------ loading --
    def open_height(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "载入灰度高度 PNG", str(Path.home()), "PNG 图像 (*.png)")
        if path:
            self.load_height_path(path)

    def load_height_path(self, path: str) -> bool:
        try:
            hm = load_height_png(path)
        except ImageLoadError as exc:
            QMessageBox.warning(self, "无法载入高度图", str(exc))
            return False
        self._load_height(hm.data, hm.codes, hm.bit_depth,
                          os.path.basename(path), path, preset_key=None)
        return True

    def load_selected_preset(self) -> None:
        self.load_preset(str(self.combo_preset.currentData()))

    def load_preset(self, key: str) -> None:
        preset = generate_preset(key)
        defaults = preset_defaults(key)
        idx = self.combo_preset.findData(key)
        if idx >= 0 and idx != self.combo_preset.currentIndex():
            self.combo_preset.blockSignals(True)
            self.combo_preset.setCurrentIndex(idx)
            self.combo_preset.blockSignals(False)
        self._loading_controls = True
        try:
            self.spin_strength.setValue(defaults["strength"])
            self.spin_smooth.setValue(defaults["smoothing"])
            idx = self.combo_boundary.findData(defaults["boundary"])
            self.combo_boundary.setCurrentIndex(max(idx, 0))
            self._set_light_controls(defaults["light"])
        finally:
            self._loading_controls = False
        self._load_height(
            preset.height, preset.codes, 8,
            f"预设: {PRESETS[key].label}", f"preset:{key}", preset_key=key,
        )

    def _load_height(self, data, codes, bit_depth, label, source, preset_key):
        self._set_mode(MODE_GENERATED)
        self.height = np.array(data, dtype=np.float64, copy=True, order="C")
        self.codes = None if codes is None else np.array(codes, copy=True)
        self.bit_depth = int(bit_depth)
        self.height_label = label
        self.source_path = None if str(source).startswith("preset:") else source
        self.active_preset = preset_key
        self.loaded_rgb = None
        self.loaded_meta = {}
        self.loaded_path = None
        self.selection = (self.height.shape[0] // 2, self.height.shape[1] // 2)
        self.lbl_source.setText(
            f"{label}\n{self.height.shape[1]}×{self.height.shape[0]} px · "
            f"{self.bit_depth}-bit" + (" · 可平铺" if preset_key == PRESET_WAVE else "")
        )
        self._refresh_all()
        self.statusBar().showMessage(f"已载入 {label}", 4000)

    def _return_to_height(self) -> None:
        self._set_mode(MODE_GENERATED)
        if self.height is None:
            self._refresh_all()
            return
        self._refresh_all()
        self.statusBar().showMessage("已返回生成模式 (原有高度数据保留)", 5000)

    # ------------------------------------------------------------ rebuild --
    def _on_param_changed(self) -> None:
        if self.mode == MODE_LOADED:
            # Bytes are fixed; a green change means "re-interpret storage".
            self._refresh_loaded_decode()
            self._update_green_hint()
            return
        self._refresh_all()

    def _on_light_changed(self) -> None:
        self._refresh_lighting()

    def _on_markers_toggled(self, enabled: bool) -> None:
        self._markers_enabled = bool(enabled)
        self._refresh_markers()

    def _on_zoom_changed(self) -> None:
        zoom = int(self.combo_zoom.currentData())
        for cb in self.all_canvases():
            cb.set_zoom(zoom)

    def _refresh_all(self) -> None:
        if self.mode == MODE_LOADED:
            self._refresh_loaded_decode()
            return
        if self.height is None:
            for cb in self.all_canvases():
                cb.set_message("载入高度 PNG 或选择一个预设")
            self.lbl_readout.setText("—")
            self._update_preset_check()
            return
        self.canvas_height.set_image(grey_uint8(self.height))
        self.canvas_height.set_caption(
            f"原始高度 · {self.bit_depth}-bit · {self.height.shape[1]}×"
            f"{self.height.shape[0]} · 越亮越高 (行 0 在上)")
        self.build = build_normals(self.height, self.params)
        self.canvas_processed.set_image(grey_uint8(self.build.processed))
        self.canvas_processed.set_caption(
            f"处理后高度 · σ={self.params.smoothing:.2f} · "
            f"{BOUNDARY_LABELS[self.params.boundary]}")
        self.rgb = self.build.rgb
        self.decoded = DecodedNormals(
            raw=self.build.decoded_raw,
            length=self.build.decoded_length,
            unit=self.build.decoded,
        )
        self.canvas_normal.set_image(self.rgb)
        self._update_normal_caption()
        self._update_green_hint()
        self._update_boundary_hint()
        self._refresh_lighting()
        self._update_preset_check()

    def _update_normal_caption(self) -> None:
        if self.rgb is None:
            return
        green = self.params.green if self.mode == MODE_GENERATED else str(
            self.combo_green.currentData())
        self.canvas_normal.set_caption(
            f"{self.rgb.shape[1]}×{self.rgb.shape[0]} · 绿色 {GREEN_LABELS[green]} · "
            "负1..1 → 0..255")

    # ---------------------------------------------------------- lighting --
    def _refresh_lighting(self) -> None:
        if self.rgb is None or self.decoded is None:
            return
        h, w = self.rgb.shape[:2]
        light = self.light
        lvec = light_direction_field(w, h, light)
        self.light_vectors = lvec
        self.lit = shade(self.decoded.unit, lvec, light.ambient, light.diffuse)
        flat_n = np.zeros((h, w, 3), dtype=np.float64)
        flat_n[..., 2] = 1.0
        self.flat_lit = shade(flat_n, lvec, light.ambient, light.diffuse)
        self.canvas_material.set_image(grey_uint8(self.lit))
        self.canvas_flat.set_image(grey_uint8(self.flat_lit))
        self.canvas_material.set_light(light)
        self.canvas_flat.set_light(light)
        self.lbl_light_hint.setText(
            f"灯位平面 ({light.plane_x:+.2f}, {light.plane_y:+.2f}) · "
            f"高度 {light.height:.2f}×S\n"
            f"环境 {light.ambient:.2f} / 漫反射 {light.diffuse:.2f} · "
            "仅 Lambert + 环境光")
        self._refresh_markers()
        self._update_readout()
        self._update_preset_check()

    def _refresh_markers(self) -> None:
        enabled = self._markers_enabled and self.chk_markers.isChecked()
        row, col = self.selection
        for cb in self.all_canvases():
            cb.set_selection(row if enabled else None, col if enabled else None)
            cb.set_vectors(None, None)
        if not enabled or self.rgb is None or self.decoded is None:
            return
        h, w = self.rgb.shape[:2]
        r = min(max(row, 0), h - 1)
        c = min(max(col, 0), w - 1)
        n = self.decoded.unit[r, c]
        l = light_direction_at(r, c, w, h, self.light)
        self.canvas_material.set_vectors(n, l)
        self.canvas_flat.set_vectors(None, l)

    # ----------------------------------------------------------- readout --
    def _update_readout(self) -> None:
        if self.decoded is None or self.rgb is None:
            self.lbl_readout.setText("—")
            return
        h, w = self.rgb.shape[:2]
        r = min(max(self.selection[0], 0), h - 1)
        c = min(max(self.selection[1], 0), w - 1)
        n = self.decoded.unit[r, c]
        raw = self.decoded.raw[r, c]
        length = float(self.decoded.length[r, c])
        light = self.light
        lvec = light_direction_at(r, c, w, h, light)
        ndotl = float(np.dot(n, lvec))
        intensity = float(shade(n.reshape(1, 1, 3), lvec.reshape(1, 1, 3),
                                light.ambient, light.diffuse)[0, 0])
        flat_i = float(shade(np.array([0.0, 0.0, 1.0]).reshape(1, 1, 3),
                             lvec.reshape(1, 1, 3), light.ambient,
                             light.diffuse)[0, 0])
        rgb = self.rgb[r, c]

        lines = [
            f"<b>像素</b> 列 {c}, 行 {r} &nbsp;·&nbsp; "
            f"表面 x {2*(c+0.5)/w-1:+.3f}, y {1-2*(r+0.5)/h:+.3f}"
        ]
        if self.mode == MODE_GENERATED and self.build is not None:
            code = "—" if self.codes is None else str(int(self.codes[r, c]))
            grey = float(self.height[r, c])
            lines.append(
                f"<b>高度</b> 灰度 {grey:.4f} ({grey*100:.1f}%) · 码值 {code} · "
                f"处理后 {self.build.processed[r, c]:.4f}")
        lines.append(
            f"<b>法线</b> 解码 ({raw[0]:+.3f}, {raw[1]:+.3f}, {raw[2]:+.3f}) · "
            f"长度 {length:.4f}")
        lines.append(
            f"&nbsp;&nbsp;归一化 ({n[0]:+.3f}, {n[1]:+.3f}, {n[2]:+.3f}){self._tilt(n)}")
        lines.append(
            f"<b>存储字节</b> RGB({rgb[0]}, {rgb[1]}, {rgb[2]}) · "
            f"绿色 {GREEN_LABELS[str(self.combo_green.currentData())]}")
        lines.append(
            f"<b>光照</b> N·L {ndotl:+.3f} · 强度 {intensity:.4f} "
            f"(平坦对照 {flat_i:.4f})")
        self.lbl_readout.setText("<br>".join(lines))
        self.lbl_readout.updateGeometry()

    @staticmethod
    def _tilt(n: np.ndarray) -> str:
        if abs(n[0]) <= 0.02 and abs(n[1]) <= 0.02:
            return " &nbsp;朝向正 z (平坦)"
        parts = []
        if n[0] > 0.02:
            parts.append("+x 右")
        elif n[0] < -0.02:
            parts.append("−x 左")
        if n[1] > 0.02:
            parts.append("+y 上")
        elif n[1] < -0.02:
            parts.append("−y 下")
        return " &nbsp;偏向 " + " ".join(parts)

    def _update_green_hint(self) -> None:
        green = str(self.combo_green.currentData())
        if self.mode == MODE_GENERATED:
            if green == GREEN_Y_UP:
                text = ("G = +Y: 存储 ny 原样。切换只改变 G 的存储值; "
                        "几何与光照不变。")
            else:
                text = ("G = −Y: 存储时取 255−G; 解码时再取反。切换只改变 G 的"
                        "存储值; 几何与光照不变。")
        else:
            if green == GREEN_Y_UP:
                text = "回读模式: 按 +Y 解释现有 G 字节; 若凹凸相反, 请切到 −Y。"
            else:
                text = "回读模式: 按 −Y 解释现有 G 字节 (G 取反); 用于 DirectX 风格图。"
        self.lbl_green_hint.setText(text)

    def _update_boundary_hint(self) -> None:
        if str(self.combo_boundary.currentData()) == BOUNDARY_WRAP:
            self.lbl_boundary_hint.setText(
                "周期边界: 右邻取同一行最左像素, 下邻取同一列最上像素; "
                "用于可平铺样例。")
        else:
            self.lbl_boundary_hint.setText(
                "边界延续: 边缘复制自身作为邻域; 非平铺样例更自然。")

    # ------------------------------------------------------- preset check --
    def _update_preset_check(self) -> None:
        if self.mode != MODE_GENERATED or self.active_preset is None or self.build is None:
            if self.mode == MODE_GENERATED and self.active_preset is None:
                self.lbl_check.setText(
                    "载入内置预设后可看到独立的预期法线与固定灯位读数。")
            elif self.mode == MODE_LOADED:
                self.lbl_check.setText(
                    "回读模式: 读取的是现有法线字节。改灯位后读数应与此前导出的记录"
                    "同时变化、方向一致。")
            return
        key = self.active_preset
        h, w = self.build.rgb.shape[:2]
        row, col = h // 2, w // 2
        rows = [f"<b>预设: {PRESETS[key].label}</b>"]
        if PRESETS[key].has_analytic_normal:
            expected = expected_normal_for_ramp(key, self.params.strength, w)
            got = self.build.geometric[row, col]
            err = float(np.abs(got - expected).max())
            exp_i = fixed_lamp_intensity(
                expected, row, col, w, h, VALIDATION_LIGHT)
            # Independent check: shade the stored (decoded) normal with the
            # SAME fixed lamp, not with whatever the preview lamp happens to be.
            stored = self.build.decoded[row, col]
            got_i = fixed_lamp_intensity(
                stored, row, col, w, h, VALIDATION_LIGHT)
            rows.append(f"期望法线 ({expected[0]:+.4f}, {expected[1]:+.4f}, "
                        f"{expected[2]:+.4f})")
            rows.append(f"实际法线 ({got[0]:+.4f}, {got[1]:+.4f}, {got[2]:+.4f})"
                        f" · 最大误差 {err:.5f}")
            rows.append(f"固定灯位读数 期望 {exp_i:.4f} / 实得 {got_i:.4f} · "
                        f"差 {abs(got_i - exp_i):.4f}")
            rows.append(
                f"固定灯位 = (X {VALIDATION_LIGHT.plane_x:+.2f}, "
                f"Y {VALIDATION_LIGHT.plane_y:+.2f}, "
                f"高度 {VALIDATION_LIGHT.height:.2f}×S, "
                f"环境 {VALIDATION_LIGHT.ambient:.2f}, "
                f"漫反射 {VALIDATION_LIGHT.diffuse:.2f}), 与预览灯位无关。")
            rows.append("允许 8-bit 存储量化 (约 ±0.004/通道)。")
        elif key == PRESET_WAVE:
            dec = self.build.decoded
            want = expected_normal_wave(self.params.strength, w)
            tol = wave_tolerance(self.params.strength)
            err = float(np.abs(dec - want).max())
            edge_err = float(np.abs(
                np.concatenate([dec[0], dec[-1], dec[:, 0], dec[:, -1]])
                - np.concatenate([want[0], want[-1], want[:, 0], want[:, -1]])
            ).max())
            rows.append(f"解析法线最大误差 {err:.4f} · 四边误差 {edge_err:.4f} "
                        f"· 容差 {tol:.4f}")
            rows.append("wrap 边界下四边的邻域含义一致; 误差来自 8-bit 高度量化, "
                        "不是接缝。")
        self.lbl_check.setText("<br>".join(rows))

    # --------------------------------------------------------- selection --
    def on_pixel_picked(self, row: int, col: int) -> None:
        self.selection = (int(row), int(col))
        self._refresh_markers()
        self._update_readout()

    def on_light_dragged(self, lx: float, ly: float) -> None:
        for w, v in ((self.spin_lx, lx), (self.spin_ly, ly)):
            w.blockSignals(True)
            w.setValue(v)
            w.blockSignals(False)
        self._refresh_lighting()

    # ------------------------------------------------------------ export --
    def export_normal(self) -> None:
        if self.mode != MODE_GENERATED or self.build is None or self.height is None:
            QMessageBox.information(self, "无可导出内容",
                                    "请先载入高度图或预设 (生成模式)。")
            return
        default_dir = Path.home() / "Desktop"
        stem = Path(self.source_path).stem if self.source_path else "heightmap"
        path, _ = QFileDialog.getSaveFileName(
            self, "导出法线 PNG", str(default_dir / f"{stem}_normal.png"),
            "PNG 图像 (*.png)")
        if not path:
            return
        if not path.lower().endswith(".png"):
            path += ".png"
        try:
            sidecar = save_normal_png(
                path, self.build.rgb,
                green=self.params.green,
                boundary=self.params.boundary,
                strength=self.params.strength,
                smoothing=self.params.smoothing,
                width=self.build.width,
                height=self.build.height,
                source_heightmap=self.source_path or self.height_label,
                light=self.light,
            )
        except Exception as exc:  # pragma: no cover - dialog path
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        self.statusBar().showMessage(f"已导出 {path} 与 {sidecar.name}", 8000)
        QMessageBox.information(
            self, "导出完成",
            f"法线 PNG:\n{path}\n\n参数记录:\n{sidecar}\n\n"
            "记录包含坐标约定、绿色通道、边界、高度强度、预平滑和校验灯光。\n"
            "可用“载入法线做光照核对”回读验证。")

    def load_normal_for_check(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "载入法线 PNG 做光照核对", str(Path.home()), "PNG 图像 (*.png)")
        if path:
            self.load_normal_path(path)

    def load_normal_path(self, path: str, green: Optional[str] = None) -> None:
        try:
            nm = load_normal_png(path, green=green)
        except ImageLoadError as exc:
            QMessageBox.warning(self, "无法载入法线图", str(exc))
            return
        self._set_mode(MODE_LOADED)
        self.loaded_rgb = np.ascontiguousarray(nm.rgb)
        self.loaded_meta = dict(nm.meta)
        self.loaded_path = path
        # Height data is kept so "返回生成模式" does not discard work; the
        # loaded bytes simply take over the normal/material views until then.

        meta = self.loaded_meta
        resolved = meta["green_channel_resolved"]
        idx = self.combo_green.findData(resolved)
        if idx >= 0:
            self.combo_green.blockSignals(True)
            self.combo_green.setCurrentIndex(idx)
            self.combo_green.blockSignals(False)
        if meta.get("height_strength") is not None:
            self.spin_strength.blockSignals(True)
            self.spin_strength.setValue(float(meta["height_strength"]))
            self.spin_strength.blockSignals(False)
        if meta.get("smoothing_sigma") is not None:
            self.spin_smooth.blockSignals(True)
            self.spin_smooth.setValue(float(meta["smoothing_sigma"]))
            self.spin_smooth.blockSignals(False)
        if meta.get("boundary") in BOUNDARIES:
            i = self.combo_boundary.findData(meta["boundary"])
            if i >= 0:
                self.combo_boundary.setCurrentIndex(i)
        self._set_light_controls(light_from_meta(meta, self.light))

        h, w = self.loaded_rgb.shape[:2]
        self.selection = (h // 2, w // 2)
        if self.height is not None:
            self.canvas_height.set_image(grey_uint8(self.height))
            self.canvas_height.set_caption("法线回读中; 高度数据仍保留 (可返回生成模式)。")
            self.canvas_processed.set_image(grey_uint8(self.build.processed)
                                            if self.build is not None else None)
            self.canvas_processed.set_caption("光照当前作用于回读的法线字节。")
        else:
            self.canvas_height.set_message("回读模式: 无高度数据")
            self.canvas_processed.set_message("回读模式: 无高度数据")
            self.canvas_height.set_caption("法线回读不重建高度。")
            self.canvas_processed.set_caption("光照直接作用于回读的法线字节。")
        self.lbl_source.setText(
            f"法线回读: {os.path.basename(path)}\n{w}×{h} px · 按数值读取 PNG 字节")
        self._refresh_loaded_decode()
        restored = (f"绿色 {GREEN_LABELS[resolved]} · "
                    f"边界 {meta.get('boundary', '—')} · "
                    f"强度 {meta.get('height_strength', '—')}")
        self.statusBar().showMessage(
            f"已载入法线 {os.path.basename(path)} ({restored})", 10000)

    def _refresh_loaded_decode(self) -> None:
        if self.loaded_rgb is None:
            return
        green = str(self.combo_green.currentData())
        self.decoded = decode_normal_rgb(self.loaded_rgb, green)
        self.rgb = self.loaded_rgb
        self.canvas_normal.set_image(self.rgb)
        self._update_normal_caption()
        if self.height is not None:
            self.canvas_height.set_image(grey_uint8(self.height))
            self.canvas_height.set_caption("法线回读中; 高度数据仍保留 (可返回生成模式)。")
            self.canvas_processed.set_image(
                grey_uint8(self.build.processed) if self.build is not None else None)
            self.canvas_processed.set_caption("光照当前作用于回读的法线字节。")
        else:
            self.canvas_height.set_message("回读模式: 无高度数据")
            self.canvas_processed.set_message("回读模式: 无高度数据")
            self.canvas_height.set_caption("法线回读不重建高度。")
            self.canvas_processed.set_caption("光照直接作用于回读的法线字节。")
        self._update_green_hint()
        self._update_boundary_hint()
        self.canvas_normal.set_caption(
            f"{self.rgb.shape[1]}×{self.rgb.shape[0]} · 回读 · "
            f"绿色 {GREEN_LABELS[green]}")
        self._refresh_lighting()

    # ------------------------------------------------------------- help --
    def show_help(self) -> None:
        QMessageBox.information(
            self, "坐标与操作",
            "表面坐标: x 向右, y 向上, z 朝观察者。\n"
            "图像行号向下: 第 0 行在最上方, 对应 +y。\n"
            "灰度越亮表示越高。法线 = normalize(−∂z/∂x, −∂z/∂y, 1)。\n"
            "RGB 存储: 分量 (−1..1) → round((v*0.5+0.5)*255)。\n"
            "G = +Y (OpenGL) 或 G = −Y (DirectX)。\n"
            "生成模式下切换绿色只改存储字节; 回读模式下切换则重新解释字节。\n\n"
            "操作:\n"
            "• 在材质预览中按住黄色灯标记拖动灯位\n"
            "• 在任一视图点击/拖动选择像素, 五个视图同步标记\n"
            "• 缩放只在视图内进行, 不改变起伏程度或计算尺寸\n"
            "• 导出后用“载入法线做光照核对”回读 PNG 字节并复现光照",
        )


def _make_app() -> QApplication:
    app = QApplication.instance() or QApplication([])
    app.setApplicationName("Normal Map Workbench")
    palette = QPalette()
    palette.setColor(QPalette.Window, QColor(20, 21, 26))
    palette.setColor(QPalette.WindowText, QColor(230, 231, 236))
    palette.setColor(QPalette.Base, QColor(25, 26, 32))
    palette.setColor(QPalette.Text, QColor(230, 231, 236))
    app.setPalette(palette)
    return app


def main() -> int:
    app = _make_app()
    win = MainWindow()
    win.load_preset(PRESET_WAVE)
    win.show()
    return app.exec()
