"""PySide6 主窗口: 视角管理、参数、画布、区段统计、导出与校验入口。"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PySide6 import QtCore, QtGui, QtWidgets

from . import core
from .calibration import build_calibration_strip
from .canvas import ImageCanvas
from .dialogs import ValidationDialog
from .params import (PRESETS, VIEW_COLORS, LensParams, ProjectFile, ViewSource,
                     preset_integer)
from .qtio import (load_png_rgba, save_png, save_qimage_png,
                   scaled_for_preview)
from .samples import SAMPLE_H, SAMPLE_W, make_sample, make_samples
from .widgets import LensSchematic, StackedBar

QUALITY_CHOICES = [("流畅 (长边 720px)", 720),
                   ("标准 (长边 1100px)", 1100),
                   ("清晰 (长边 1800px)", 1800)]


def color_icon(view_id: int, size: int = 14) -> QtGui.QIcon:
    pm = QtGui.QPixmap(size, size)
    c = VIEW_COLORS[view_id % len(VIEW_COLORS)]
    pm.fill(QtGui.QColor(*c))
    return QtGui.QIcon(pm)


class MainWindow(QtWidgets.QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("柱镜交错拼图校准工具 — 单方向直镜条")
        self.resize(1380, 860)
        self.setMinimumSize(1120, 700)

        # ---- 状态 ----
        self.params: LensParams = preset_integer()[1]
        self.views: list[np.ndarray] = []
        self.sources: list[ViewSource] = []
        self.preview_max_side = 1100
        self._selection: tuple[int, int, int, int] | None = None
        self._dlg: ValidationDialog | None = None
        self._cache: dict = {}
        self._small_views: list[np.ndarray] | None = None

        self._build_actions()
        self._build_ui()
        self._build_menu()

        # 启动即给 3 张内置样例
        self.load_builtin_samples(3)
        self._sync_controls_from_params()
        self.rebuild_all()

    # ==================================================================
    # UI 构建
    # ==================================================================
    def _build_actions(self) -> None:
        self.act_export_inter = QtGui.QAction("导出交错原像素 PNG…", self)
        self.act_export_inter.triggered.connect(self.export_interlaced)
        self.act_export_layer = QtGui.QAction("导出来源图层 PNG…", self)
        self.act_export_layer.triggered.connect(self.export_layer)
        self.act_export_cal = QtGui.QAction("导出带刻度校准条 PNG…", self)
        self.act_export_cal.triggered.connect(self.export_calibration)
        self.act_save_params = QtGui.QAction("保存参数…", self)
        self.act_save_params.triggered.connect(self.save_params)
        self.act_load_params = QtGui.QAction("加载参数…", self)
        self.act_load_params.triggered.connect(self.load_params)
        self.act_validate = QtGui.QAction("本地校验: 图首/图中/图尾…", self)
        self.act_validate.triggered.connect(self.open_validation)

    def _build_menu(self) -> None:
        m_file = self.menuBar().addMenu("文件")
        m_file.addAction(self.act_save_params)
        m_file.addAction(self.act_load_params)
        m_file.addSeparator()
        m_file.addAction(self.act_export_inter)
        m_file.addAction(self.act_export_layer)
        m_file.addAction(self.act_export_cal)
        m_file.addSeparator()
        act_quit = QtGui.QAction("退出", self)
        act_quit.triggered.connect(self.close)
        m_file.addAction(act_quit)

        m_chk = self.menuBar().addMenu("校验")
        m_chk.addAction(self.act_validate)
        m_preset = m_chk.addMenu("内置例子")
        for key, text in (("integer", "整数周期 P=3"),
                          ("half_pixel", "半像素偏移 0.5px"),
                          ("fractional", "非整除 P=3.5"),
                          ("tilt", "小倾角串图")):
            a = QtGui.QAction(text, self)
            a.triggered.connect(lambda _=False, k=key: self.load_preset(k))
            m_preset.addAction(a)

    def _build_ui(self) -> None:
        splitter = QtWidgets.QSplitter(QtCore.Qt.Orientation.Horizontal)

        # ---------- 左: 控制区 ----------
        controls = self._build_controls()
        scroll_left = QtWidgets.QScrollArea()
        scroll_left.setWidgetResizable(True)
        scroll_left.setWidget(controls)
        scroll_left.setMinimumWidth(310)
        scroll_left.setMaximumWidth(390)
        splitter.addWidget(scroll_left)

        # ---------- 中: 示意 + 画布 ----------
        center = QtWidgets.QWidget()
        cv = QtWidgets.QVBoxLayout(center)
        cv.setContentsMargins(6, 6, 6, 6)

        toolbar = QtWidgets.QHBoxLayout()
        for text, slot in (("放大", lambda: self.canvas.zoom_by(1.25)),
                           ("缩小", lambda: self.canvas.zoom_by(1 / 1.25)),
                           ("适应窗口", lambda: self.canvas.reset_view()),
                           ("1:1 (100%)", self._zoom_actual),
                           ("选区扩为整根镜条", self.expand_selection_full_lens)):
            b = QtWidgets.QPushButton(text)
            b.clicked.connect(slot)
            toolbar.addWidget(b)
        toolbar.addStretch(1)
        hint = QtWidgets.QLabel("左键拖框选区段 · 单击选整根镜条(全高) · Ctrl+滚轮缩放 · 中键平移")
        hint.setStyleSheet("color:#888;")
        toolbar.addWidget(hint)
        cv.addLayout(toolbar)

        self.schematic = LensSchematic()
        self.schematic.eyeChanged.connect(self._on_schematic_eye)
        cv.addWidget(self.schematic)

        eye_row = QtWidgets.QHBoxLayout()
        eye_row.addWidget(QtWidgets.QLabel("观察位置"))
        self.eye_slider = QtWidgets.QSlider(QtCore.Qt.Orientation.Horizontal)
        self.eye_slider.setRange(0, 1000)
        self.eye_slider.setValue(180)
        self.eye_slider.valueChanged.connect(self._on_eye_slider)
        eye_row.addWidget(self.eye_slider, 1)
        self.lbl_eye = QtWidgets.QLabel("0.180")
        self.lbl_eye.setMinimumWidth(46)
        eye_row.addWidget(self.lbl_eye)
        cv.addLayout(eye_row)

        self.canvas = ImageCanvas()
        self.canvas.rectSelected.connect(self._on_rect_selected)
        cv.addWidget(self.canvas, 1)
        splitter.addWidget(center)

        # ---------- 右: 区段统计 + 相位 ----------
        right = self._build_right_panel()
        right_scroll = QtWidgets.QScrollArea()
        right_scroll.setWidgetResizable(True)
        right_scroll.setWidget(right)
        right_scroll.setMinimumWidth(300)
        right_scroll.setMaximumWidth(430)
        splitter.addWidget(right_scroll)

        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 3)
        splitter.setStretchFactor(2, 0)
        splitter.setSizes([340, 820, 360])
        self.setCentralWidget(splitter)
        self.statusBar().showMessage("就绪")

    def _build_controls(self) -> QtWidgets.QWidget:
        w = QtWidgets.QWidget()
        v = QtWidgets.QVBoxLayout(w)
        v.setSpacing(10)

        # --- 视角画面 ---
        gb_views = QtWidgets.QGroupBox("① 视角画面 (2–4 张同尺寸 PNG)")
        f1 = QtWidgets.QVBoxLayout(gb_views)
        row = QtWidgets.QHBoxLayout()
        self.sample_n_spin = QtWidgets.QSpinBox()
        self.sample_n_spin.setRange(2, 4)
        self.sample_n_spin.setValue(3)
        btn_samples = QtWidgets.QPushButton("生成内置样例")
        btn_samples.clicked.connect(
            lambda: self.load_builtin_samples(self.sample_n_spin.value()))
        row.addWidget(self.sample_n_spin)
        row.addWidget(btn_samples)
        f1.addLayout(row)

        self.list_views = QtWidgets.QListWidget()
        self.list_views.setMaximumHeight(118)
        f1.addWidget(self.list_views)
        row2 = QtWidgets.QHBoxLayout()
        b_add = QtWidgets.QPushButton("添加 PNG…")
        b_add.clicked.connect(self.add_pngs)
        b_del = QtWidgets.QPushButton("移除选中")
        b_del.clicked.connect(self.remove_selected_view)
        row2.addWidget(b_add)
        row2.addWidget(b_del)
        f1.addLayout(row2)
        v.addWidget(gb_views)

        # --- 视图顺序 ---
        gb_order = QtWidgets.QGroupBox("② 切片从左到右的视图顺序(反查方向)")
        fo = QtWidgets.QVBoxLayout(gb_order)
        self.list_order = QtWidgets.QListWidget()
        self.list_order.setMaximumHeight(110)
        fo.addWidget(self.list_order)
        orow = QtWidgets.QHBoxLayout()
        b_up = QtWidgets.QPushButton("↑ 上移")
        b_down = QtWidgets.QPushButton("↓ 下移")
        b_rev = QtWidgets.QPushButton("⇄ 反转顺序")
        b_up.clicked.connect(lambda: self._move_order(-1))
        b_down.clicked.connect(lambda: self._move_order(1))
        b_rev.clicked.connect(self._reverse_order)
        orow.addWidget(b_up)
        orow.addWidget(b_down)
        orow.addWidget(b_rev)
        fo.addLayout(orow)
        v.addWidget(gb_order)

        # --- 镜片参数 ---
        gb_lens = QtWidgets.QGroupBox("③ 镜条密度 / 印刷分辨率 / 偏移")
        form = QtWidgets.QFormLayout(gb_lens)
        self.dpi_spin = QtWidgets.QSpinBox()
        self.dpi_spin.setRange(72, 4800)
        self.dpi_spin.setValue(300)
        self.dpi_spin.valueChanged.connect(self._on_settings_changed)
        form.addRow("印刷分辨率 DPI", self.dpi_spin)

        self.lpi_spin = QtWidgets.QDoubleSpinBox()
        self.lpi_spin.setRange(5.0, 600.0)
        self.lpi_spin.setDecimals(2)
        self.lpi_spin.setSingleStep(1.0)
        self.lpi_spin.setValue(75.0)
        self.lpi_spin.valueChanged.connect(self._on_settings_changed)
        form.addRow("镜条密度 LPI", self.lpi_spin)

        self.lbl_pitch = QtWidgets.QLabel("P = 4.0000 px/镜条")
        self.lbl_pitch.setStyleSheet("font-weight:bold;")
        form.addRow("镜条周期", self.lbl_pitch)

        self.offset_spin = QtWidgets.QDoubleSpinBox()
        self.offset_spin.setRange(-200.0, 200.0)
        self.offset_spin.setDecimals(3)
        self.offset_spin.setSingleStep(0.1)
        self.offset_spin.setValue(0.0)
        self.offset_spin.valueChanged.connect(self._on_settings_changed)
        form.addRow("起始偏移 px", self.offset_spin)

        self.chk_whole = QtWidgets.QCheckBox("首尾同相位(修正为整数个周期)")
        self.chk_whole.toggled.connect(self._on_whole_toggled)
        form.addRow(self.chk_whole)

        self.chk_fit = QtWidgets.QCheckBox("锁定右端相位(微调周期)")
        self.chk_fit.toggled.connect(self._on_fit_toggled)
        form.addRow(self.chk_fit)
        self.rightphase_spin = QtWidgets.QDoubleSpinBox()
        self.rightphase_spin.setRange(0.0, 0.999)
        self.rightphase_spin.setDecimals(3)
        self.rightphase_spin.setSingleStep(0.05)
        self.rightphase_spin.setValue(0.0)
        self.rightphase_spin.valueChanged.connect(self._on_settings_changed)
        self.rightphase_spin.setEnabled(False)
        form.addRow("右端相位", self.rightphase_spin)
        v.addWidget(gb_lens)

        # --- 倾角 ---
        gb_tilt = QtWidgets.QGroupBox("④ 镜片微小倾角(预览对位误差)")
        ft = QtWidgets.QFormLayout(gb_tilt)
        self.angle_spin = QtWidgets.QDoubleSpinBox()
        self.angle_spin.setRange(-8.0, 8.0)
        self.angle_spin.setDecimals(3)
        self.angle_spin.setSingleStep(0.05)
        self.angle_spin.setValue(0.0)
        self.angle_spin.valueChanged.connect(self._on_settings_changed)
        ft.addRow("倾角 θ (度)", self.angle_spin)
        self.pivot_combo = QtWidgets.QComboBox()
        self.pivot_combo.addItem("顶行正确(向下逐渐串图)", 0.0)
        self.pivot_combo.addItem("中间正确(两端漂移)", 0.5)
        self.pivot_combo.addItem("底行正确(向上逐渐串图)", 1.0)
        self.pivot_combo.currentIndexChanged.connect(self._on_settings_changed)
        ft.addRow("基准侧", self.pivot_combo)
        self.eyewidth_spin = QtWidgets.QDoubleSpinBox()
        self.eyewidth_spin.setRange(0.05, 3.0)
        self.eyewidth_spin.setDecimals(2)
        self.eyewidth_spin.setSingleStep(0.05)
        self.eyewidth_spin.setValue(0.85)
        self.eyewidth_spin.valueChanged.connect(self._on_settings_changed)
        ft.addRow("观察窗口宽(切片=1)", self.eyewidth_spin)
        v.addWidget(gb_tilt)

        # --- 显示 ---
        gb_disp = QtWidgets.QGroupBox("⑤ 显示 / 图层")
        fd = QtWidgets.QFormLayout(gb_disp)
        self.mode_combo = QtWidgets.QComboBox()
        self.mode_combo.addItems(["交错成品(供印刷)", "来源彩色图层",
                                  "成品+来源叠加", "压镜观察模拟"])
        self.mode_combo.currentIndexChanged.connect(self.refresh_display)
        fd.addRow("主画面", self.mode_combo)
        self.solo_combo = QtWidgets.QComboBox()
        self.solo_combo.currentIndexChanged.connect(self.refresh_display)
        fd.addRow("图层单看", self.solo_combo)
        self.chk_lens = QtWidgets.QCheckBox("叠加镜条分界线")
        self.chk_lens.setChecked(True)
        self.chk_lens.toggled.connect(self.refresh_display)
        fd.addRow(self.chk_lens)
        self.quality_combo = QtWidgets.QComboBox()
        for text, val in QUALITY_CHOICES:
            self.quality_combo.addItem(text, val)
        self.quality_combo.setCurrentIndex(1)
        self.quality_combo.currentIndexChanged.connect(self._on_quality_changed)
        fd.addRow("缩略图清晰度", self.quality_combo)
        qhint = QtWidgets.QLabel("降低清晰度只影响屏幕缩略图,\n导出始终是原 PNG 像素与取样。")
        qhint.setStyleSheet("color:#888;")
        qhint.setWordWrap(True)
        fd.addRow(qhint)
        v.addWidget(gb_disp)

        # --- 内置例子 / 校验 ---
        gb_ex = QtWidgets.QGroupBox("⑥ 内置例子与本地校验")
        fe = QtWidgets.QGridLayout(gb_ex)
        for i, (key, text) in enumerate((
                ("integer", "整数周期"),
                ("half_pixel", "半像素偏移"),
                ("fractional", "P=3.5 非整除"),
                ("tilt", "倾角串图"))):
            b = QtWidgets.QPushButton(text)
            b.clicked.connect(lambda _=False, k=key: self.load_preset(k))
            fe.addWidget(b, i // 2, i % 2)
        b_chk = QtWidgets.QPushButton("打开首/中/尾校验…")
        b_chk.setStyleSheet("font-weight:bold;")
        b_chk.clicked.connect(self.open_validation)
        fe.addWidget(b_chk, 2, 0, 1, 2)
        v.addWidget(gb_ex)

        # --- 导出 / 工程 ---
        gb_out = QtWidgets.QGroupBox("⑦ 导出 / 参数")
        fo2 = QtWidgets.QVBoxLayout(gb_out)
        for act in (self.act_export_inter, self.act_export_layer,
                     self.act_export_cal):
            b = QtWidgets.QPushButton(act.text())
            b.clicked.connect(act.trigger)
            fo2.addWidget(b)
        hr = QtWidgets.QHBoxLayout()
        b_save = QtWidgets.QPushButton("保存参数 JSON")
        b_save.clicked.connect(self.save_params)
        b_load = QtWidgets.QPushButton("加载参数 JSON")
        b_load.clicked.connect(self.load_params)
        hr.addWidget(b_save)
        hr.addWidget(b_load)
        fo2.addLayout(hr)
        v.addWidget(gb_out)
        v.addStretch(1)
        return w

    def _build_right_panel(self) -> QtWidgets.QWidget:
        w = QtWidgets.QWidget()
        v = QtWidgets.QVBoxLayout(w)

        gb = QtWidgets.QGroupBox("同一根镜条下各视角占用")
        form = QtWidgets.QVBoxLayout(gb)
        self.lbl_sel_info = QtWidgets.QLabel("在中间图上左键拖选一段;\n单击可选中整根镜条(全高)。")
        self.lbl_sel_info.setWordWrap(True)
        form.addWidget(self.lbl_sel_info)
        self.bar = StackedBar()
        form.addWidget(self.bar)
        self.table = QtWidgets.QTableWidget(0, 6)
        self.table.setHorizontalHeaderLabels(["视角", "像素", "宽 px", "宽 in", "占比", "偏差"])
        self.table.verticalHeader().setVisible(False)
        hh = self.table.horizontalHeader()
        hh.setSectionResizeMode(0, QtWidgets.QHeaderView.ResizeMode.Stretch)
        for col in range(1, 6):
            hh.setSectionResizeMode(col, QtWidgets.QHeaderView.ResizeMode.ResizeToContents)
        self.table.setMaximumHeight(190)
        form.addWidget(self.table)
        form.addWidget(QtWidgets.QLabel("参考行上的连续取样段(左→右):"))
        self.txt_runs = QtWidgets.QPlainTextEdit()
        self.txt_runs.setReadOnly(True)
        f = QtGui.QFont("Menlo")
        f.setPointSize(10)
        self.txt_runs.setFont(f)
        self.txt_runs.setMaximumHeight(150)
        form.addWidget(self.txt_runs)
        b_expand = QtWidgets.QPushButton("把当前选区扩为整根镜条(全高)")
        b_expand.clicked.connect(self.expand_selection_full_lens)
        form.addWidget(b_expand)
        v.addWidget(gb)

        gb_phase = QtWidgets.QGroupBox("相位核对(图首 / 图尾)")
        vp = QtWidgets.QVBoxLayout(gb_phase)
        self.lbl_phase = QtWidgets.QLabel()
        self.lbl_phase.setWordWrap(True)
        f2 = QtGui.QFont("Menlo")
        f2.setPointSize(10)
        self.lbl_phase.setFont(f2)
        vp.addWidget(self.lbl_phase)
        v.addWidget(gb_phase)
        v.addStretch(1)
        return w

    # ==================================================================
    # 视图 / 来源管理
    # ==================================================================
    def load_builtin_samples(self, n: int) -> None:
        n = int(np.clip(n, 2, 4))
        self.views = make_samples(n)
        self.sources = [ViewSource(kind="sample", sample_index=i,
                                   label=f"内置样例 {i + 1}") for i in range(n)]
        self.params.order = tuple(range(n))
        self.sample_n_spin.blockSignals(True)
        self.sample_n_spin.setValue(n)
        self.sample_n_spin.blockSignals(False)
        self._after_views_changed(reset_view=True)
        self.statusBar().showMessage(f"已生成 {n} 张 {SAMPLE_W}×{SAMPLE_H} 内置样例")

    def add_pngs(self) -> None:
        paths, _ = QtWidgets.QFileDialog.getOpenFileNames(
            self, "选择 2–4 张同尺寸 PNG", "", "PNG 图片 (*.png)")
        if not paths:
            return
        loaded: list[tuple[np.ndarray, str]] = []
        for path in paths:
            try:
                loaded.append((load_png_rgba(path), path))
            except Exception as e:  # noqa: BLE001
                QtWidgets.QMessageBox.warning(self, "读取失败", f"{path}\n{e}")
        if not loaded:
            return

        sizes = {arr.shape[:2] for arr, _ in loaded}
        if len(sizes) > 1:
            QtWidgets.QMessageBox.warning(
                self, "尺寸不一致",
                "你选的这些 PNG 彼此尺寸不同；需求要求 2–4 张完全同尺寸。")
            return
        new_h, new_w = loaded[0][0].shape[:2]

        # 与当前会话尺寸不同: 若一次选了 >=2 张, 询问是否整体替换
        if self.views and (new_h, new_w) != self.views[0].shape[:2]:
            if len(loaded) < 2:
                QtWidgets.QMessageBox.warning(
                    self, "需要至少 2 张",
                    "所选 PNG 与当前画面尺寸不同。请一次选择 2–4 张同尺寸 PNG 来开始新组。")
                return
            ans = QtWidgets.QMessageBox.question(
                self, "用所选 PNG 替换当前视角?",
                f"所选 {len(loaded)} 张均为 {new_w}×{new_h}, 与当前 "
                f"{self.views[0].shape[1]}×{self.views[0].shape[0]} 不同。\n\n"
                "Yes = 用它们替换当前视角组;  No = 取消。")
            if ans != QtWidgets.QMessageBox.StandardButton.Yes:
                return
            loaded = loaded[:4]
            self.views = [arr for arr, _ in loaded]
            self.sources = [
                ViewSource(kind="file", path=str(Path(path).resolve()),
                           label=Path(path).stem)
                for _, path in loaded]
            self.params.order = tuple(range(len(self.views)))
            self._after_views_changed(reset_view=True)
            self.statusBar().showMessage(
                f"已载入 {len(self.views)} 张 {new_w}×{new_h} PNG")
            return

        # 尺寸一致 -> 追加(最多 4 张)
        first_shape = self.views[0].shape[:2] if self.views else None
        added = 0
        for arr, path in loaded:
            if len(self.views) >= 4:
                QtWidgets.QMessageBox.warning(self, "最多 4 张", "最多支持 4 个视角。")
                break
            if first_shape is not None and arr.shape[:2] != first_shape:
                continue
            first_shape = arr.shape[:2]
            self.views.append(arr)
            self.sources.append(ViewSource(
                kind="file", path=str(Path(path).resolve()),
                label=Path(path).stem))
            added += 1
        if added:
            n = len(self.views)
            self.params.order = tuple(range(n))
            self._after_views_changed(reset_view=True)
            self.statusBar().showMessage(f"已添加 {added} 张 PNG, 共 {n} 张")

    def remove_selected_view(self) -> None:
        row = self.list_views.currentRow()
        if row < 0:
            row = len(self.views) - 1
        if len(self.views) <= 2:
            QtWidgets.QMessageBox.information(self, "至少 2 张", "工具需要 2–4 个视角。")
            return
        del self.views[row]
        del self.sources[row]
        # 重映射顺序里的视角编号
        new_order = []
        for vid in self.params.order:
            if vid == row:
                continue
            new_order.append(vid - 1 if vid > row else vid)
        self.params.order = tuple(core.normalize_order(new_order, len(self.views)))
        self._after_views_changed(reset_view=True)

    def _after_views_changed(self, reset_view: bool = False) -> None:
        n = len(self.views)
        self.params.order = self.params.normalized_order(n)
        self._selection = None
        self._small_views = None
        self.canvas.set_selection_rect(None)
        self.canvas.set_highlight_polygon(None)
        if reset_view:
            self.canvas._has_fit_once = False  # 让新图重新适应窗口
        self._refresh_view_lists()
        self._sync_controls_from_params()
        self.rebuild_all()

    def _view_label(self, vid: int) -> str:
        if 0 <= vid < len(self.sources):
            s = self.sources[vid]
            if s.kind == "file" and s.path:
                return f"视角 {vid + 1} · {Path(s.path).stem}"
            return f"视角 {vid + 1} · 内置样例 {s.sample_index + 1}"
        return f"视角 {vid + 1}"

    def _refresh_view_lists(self) -> None:
        n = len(self.views)
        self.sample_n_spin.blockSignals(True)
        self.sample_n_spin.setValue(n)
        self.sample_n_spin.blockSignals(False)
        self.list_views.clear()
        for i in range(n):
            item = QtWidgets.QListWidgetItem(color_icon(i), self._view_label(i))
            self.list_views.addItem(item)

        self.list_order.clear()
        for k, vid in enumerate(self.params.normalized_order(n)):
            item = QtWidgets.QListWidgetItem(
                color_icon(vid), f"切片段 {k + 1}  →  {self._view_label(vid)}")
            item.setData(QtCore.Qt.ItemDataRole.UserRole, int(vid))
            self.list_order.addItem(item)

        cur_solo = self.solo_combo.currentIndex()
        self.solo_combo.blockSignals(True)
        self.solo_combo.clear()
        self.solo_combo.addItem("全部来源", -1)
        for i in range(n):
            self.solo_combo.addItem(f"只看视角 {i + 1} 的取片位置", i)
        self.solo_combo.setCurrentIndex(max(0, min(cur_solo, n)))
        self.solo_combo.blockSignals(False)

    # ==================================================================
    # 参数同步
    # ==================================================================
    def _sync_controls_from_params(self) -> None:
        p = self.params
        for wdg, val in ((self.dpi_spin, int(p.dpi)),
                          (self.lpi_spin, float(p.lpi)),
                          (self.offset_spin, float(p.offset_px)),
                          (self.angle_spin, float(p.angle_deg)),
                          (self.rightphase_spin, float(p.right_edge_phase)),
                          (self.eyewidth_spin, float(p.eye_width_slices))):
            wdg.blockSignals(True)
            wdg.setValue(val)
            wdg.blockSignals(False)
        self.chk_whole.blockSignals(True)
        self.chk_whole.setChecked(getattr(p, "whole_periods", False))
        self.chk_whole.blockSignals(False)
        self.chk_fit.blockSignals(True)
        self.chk_fit.setChecked(p.fit_right_edge)
        self.chk_fit.blockSignals(False)
        self.chk_whole.setEnabled(not p.fit_right_edge)
        self.chk_fit.setEnabled(not p.whole_periods)
        self.rightphase_spin.setEnabled(p.fit_right_edge
                                        and not p.whole_periods)

        idx = self.pivot_combo.findData(float(p.pivot_frac))
        self.pivot_combo.blockSignals(True)
        self.pivot_combo.setCurrentIndex(max(0, idx))
        self.pivot_combo.blockSignals(False)

        self.eye_slider.blockSignals(True)
        self.eye_slider.setValue(int(round(p.eye_phase * 1000)))
        self.eye_slider.blockSignals(False)
        self.lbl_eye.setText(f"{p.eye_phase:.3f}")

        qi = max(0, [v for _, v in QUALITY_CHOICES].index(self.preview_max_side)
                 if self.preview_max_side in [v for _, v in QUALITY_CHOICES] else 1)
        self.quality_combo.blockSignals(True)
        self.quality_combo.setCurrentIndex(qi)
        self.quality_combo.blockSignals(False)

        self.schematic.set_model(len(self.views), p.normalized_order(len(self.views)),
                                 p.eye_phase)
        self._refresh_view_lists()

    def _read_controls_into_params(self) -> None:
        p = self.params
        p.dpi = float(self.dpi_spin.value())
        p.lpi = float(self.lpi_spin.value())
        p.offset_px = float(self.offset_spin.value())
        p.angle_deg = float(self.angle_spin.value())
        p.pivot_frac = float(self.pivot_combo.currentData() or 0.0)
        p.whole_periods = bool(self.chk_whole.isChecked())
        p.fit_right_edge = bool(self.chk_fit.isChecked())
        p.right_edge_phase = float(self.rightphase_spin.value())
        p.eye_width_slices = float(self.eyewidth_spin.value())
        p.eye_phase = self.eye_slider.value() / 1000.0

    def _on_settings_changed(self, *_):
        self._read_controls_into_params()
        self.rebuild_all()

    def _on_whole_toggled(self, checked: bool) -> None:
        # 两种右端修正互斥
        if checked:
            self.chk_fit.blockSignals(True)
            self.chk_fit.setChecked(False)
            self.chk_fit.blockSignals(False)
        self.chk_fit.setEnabled(not checked)
        self.rightphase_spin.setEnabled(self.chk_fit.isChecked())
        self._on_settings_changed()

    def _on_fit_toggled(self, checked: bool) -> None:
        if checked:
            self.chk_whole.blockSignals(True)
            self.chk_whole.setChecked(False)
            self.chk_whole.blockSignals(False)
        self.chk_whole.setEnabled(not checked)
        self.rightphase_spin.setEnabled(checked)
        self._on_settings_changed()

    def _on_quality_changed(self, _idx: int) -> None:
        self.preview_max_side = int(self.quality_combo.currentData())
        self._small_views = None
        self.statusBar().showMessage(
            f"缩略图长边 ≤ {self.preview_max_side}px; 导出像素尺寸不变", 2500)
        self.refresh_display()

    # -- 顺序 -----------------------------------------------------------
    def _move_order(self, delta: int) -> None:
        n = len(self.views)
        row = self.list_order.currentRow()
        order = list(self.params.normalized_order(n))
        if row < 0:
            row = 0 if delta < 0 else n - 1
        new = row + delta
        if not (0 <= new < n):
            return
        order[row], order[new] = order[new], order[row]
        self.params.order = tuple(order)
        self._refresh_view_lists()
        self.list_order.setCurrentRow(new)
        self.rebuild_all()

    def _reverse_order(self) -> None:
        n = len(self.views)
        self.params.order = tuple(reversed(self.params.normalized_order(n)))
        self._refresh_view_lists()
        self.rebuild_all()
        self.statusBar().showMessage(
            "已反转视图顺序: 若观察方向看起来反了, 这就是反查左右的开关", 3500)

    # -- 观察位置 --------------------------------------------------------
    def _on_eye_slider(self, value: int) -> None:
        if self.mode_combo.currentIndex() != 3:
            self.mode_combo.setCurrentIndex(3)
        phase = value / 1000.0
        self.params.eye_phase = phase
        self.lbl_eye.setText(f"{phase:.3f}")
        self.schematic.blockSignals(True)
        self.schematic.set_phase(phase)
        self.schematic.blockSignals(False)
        self.refresh_display()

    def _on_schematic_eye(self, phase: float) -> None:
        if self.mode_combo.currentIndex() != 3:
            self.mode_combo.setCurrentIndex(3)
        self.params.eye_phase = phase
        self.eye_slider.blockSignals(True)
        self.eye_slider.setValue(int(round(phase * 1000)))
        self.eye_slider.blockSignals(False)
        self.lbl_eye.setText(f"{phase:.3f}")
        self.refresh_display()

    def _zoom_actual(self) -> None:
        # 单位变换 = 场景像素与视口像素 1:1
        self.canvas.resetTransform()

    # ==================================================================
    # 预设
    # ==================================================================
    def load_preset(self, key: str) -> None:
        name, p = PRESETS[key]()
        self.params = p
        n = len(p.order)
        self.load_builtin_samples(n)
        self.params = p  # load_builtin_samples 会重置 order, 这里重新覆盖
        self.params.order = p.normalized_order(n)
        self._sync_controls_from_params()
        self._selection = None
        self.canvas.set_selection_rect(None)
        self.canvas.set_highlight_polygon(None)
        self.rebuild_all()
        self.statusBar().showMessage(f"载入内置例子: {name}", 4000)
        if self._dlg is not None:
            try:
                self._dlg.refresh_all()
            except RuntimeError:
                self._dlg = None

    # ==================================================================
    # 核心重建
    # ==================================================================
    def rebuild_all(self) -> None:
        if not self.views:
            return
        self._read_controls_into_params() if hasattr(self, "dpi_spin") else None
        n = len(self.views)
        p = self.params
        p.order = p.normalized_order(n)
        h, w = self.views[0].shape[:2]
        pitch = core.effective_pitch(p, w)
        assign = core.assignment_map(h, w, n, pitch, p)
        layer = core.source_layer(assign, n, VIEW_COLORS)
        inter = core.interlace(self.views, p, pitch=pitch, assign=assign)
        self._cache = dict(params=p, n=n, h=h, w=w, pitch=pitch,
                           assign=assign, layer=layer, inter=inter)

        self.lbl_pitch.setText(
            f"P = {pitch:.4f} px/镜条"
            + (" (已锁定右端)" if p.fit_right_edge else f"  名义 {p.dpi / p.lpi:.4f}"))
        ep = core.edge_phases(h, w, pitch, p)
        d_lr = abs(ep["left_edge"] - ep["right_edge"])
        d_lr = min(d_lr, 1.0 - d_lr)
        same = "  ✅ 首尾同相" if d_lr < 1e-6 else ""
        self.lbl_phase.setText(
            f"左边缘相位      {ep['left_edge']:.5f}\n"
            f"右边缘相位      {ep['right_edge']:.5f}\n"
            f"左右缘相位差    {d_lr:.5f}{same}\n"
            f"首像素中心相位  {ep['first_pixel_center']:.5f}\n"
            f"末像素中心相位  {ep['last_pixel_center']:.5f}\n"
            f"W/P 总周期数    {ep['total_periods']:.5f}\n"
            f"(W={w}, P={pitch:.4f})")

        self.schematic.set_model(n, p.order, p.eye_phase)
        self._update_lens_overlay()
        self.refresh_display()
        self._update_stats()
        self.statusBar().showMessage(
            f"输出 {w}×{h} 原像素 · {n} 视角 · P={pitch:.4f}px · "
            f"预览长边≤{self.preview_max_side}px")

    def _update_lens_overlay(self) -> None:
        c = self._cache
        if not c or not self.chk_lens.isChecked():
            self.canvas.set_lens_lines([])
            return
        h, w, pitch, p = c["h"], c["w"], c["pitch"], self.params
        slope_extra = abs(core.tilt_slope(p)) * h
        m0 = int(np.floor((-p.offset_px - slope_extra) / pitch)) - 2
        m1 = int(np.ceil((w - p.offset_px + slope_extra) / pitch)) + 2
        segs = []
        for m in range(m0, m1 + 1):
            xt = core.boundary_x(m, 0.0, h, pitch, p)
            xb = core.boundary_x(m, float(h), h, pitch, p)
            if max(xt, xb) < -pitch or min(xt, xb) > w + pitch:
                continue
            segs.append((xt, 0.0, xb, float(h)))
        self.canvas.set_lens_lines(segs)

    def _display_array(self) -> np.ndarray:
        c = self._cache
        mode = self.mode_combo.currentIndex()
        assign, layer, inter = c["assign"], c["layer"], c["inter"]
        if mode == 1:  # 来源图层(可单看)
            solo = self.solo_combo.currentData()
            if solo is None or solo < 0:
                return layer
            out = np.full_like(layer, 255)
            mask = assign == int(solo)
            dim = np.empty_like(layer)
            dim[..., :3] = np.clip(
                layer[..., :3].astype(np.float32) * 0.22 + 220,
                0, 255).astype(np.uint8)
            dim[..., 3] = 255  # 不能让 alpha 参与 220 偏移, 否则 uint8 溢出变透明
            out[:] = dim
            out[mask] = layer[mask]
            return out
        if mode == 2:
            return core.blend_overlay(inter, layer, 0.42)
        if mode == 3:
            return self._compose_observer_preview()
        return inter

    def _compose_observer_preview(self) -> QtGui.QPixmap:
        c = self._cache
        h, w, pitch = c["h"], c["w"], c["pitch"]
        if self._small_views is None:
            self._small_views = [scaled_for_preview(v, self.preview_max_side)
                                 for v in self.views]
        prev = core.compose_preview(self._small_views, h, self.params, pitch)
        qimg = QtGui.QImage(prev.data, prev.shape[1], prev.shape[0],
                            4 * prev.shape[1],
                            QtGui.QImage.Format.Format_RGBA8888).copy()
        # 放大回原生场景尺寸, 仅用于显示; 平滑缩放 = 缩略图清晰度取舍
        full = qimg.scaled(w, h,
                           QtCore.Qt.AspectRatioMode.IgnoreAspectRatio,
                           QtCore.Qt.TransformationMode.SmoothTransformation)
        return QtGui.QPixmap.fromImage(full)

    def refresh_display(self, *_):
        if not self._cache:
            return
        data = self._display_array()
        if isinstance(data, QtGui.QPixmap):
            self.canvas.set_image_qimage(data.toImage())
        else:
            self.canvas.set_image_array(data)
        # set_image 保留 rubber; 但新 QImage 不改变 selection 数据
        self._update_lens_overlay()

    # ==================================================================
    # 选区 / 统计
    # ==================================================================
    def _on_rect_selected(self, rect, is_click: bool) -> None:
        c = self._cache
        if not c:
            return
        p, pitch = self.params, c["pitch"]
        if is_click:
            x0, y0, x1, y1 = rect
            rect = core.lens_span_rect((c["h"], c["w"]), p, pitch, x0, y0,
                                       full_height=True)
            self.canvas.set_selection_rect(rect)
        self._selection = rect
        self._update_stats()

    def expand_selection_full_lens(self) -> None:
        c = self._cache
        if not c:
            return
        if self._selection is None:
            self.statusBar().showMessage("先在图上点一下或框选一段", 2500)
            return
        x0, y0, x1, y1 = self._selection
        rect = core.lens_span_rect((c["h"], c["w"]), self.params, c["pitch"],
                                   (x0 + x1) // 2, (y0 + y1) // 2,
                                   full_height=True)
        self._selection = rect
        self.canvas.set_selection_rect(rect)
        self._update_stats()

    def _update_stats(self) -> None:
        c = self._cache
        if not c or self._selection is None:
            return
        stat = core.analyze_segment(c["assign"], self.params, c["pitch"],
                                    self._selection)
        n = c["n"]
        p, pitch = self.params, c["pitch"]
        x0, y0, x1, y1 = stat.rect
        self.lbl_sel_info.setText(
            f"选区 x {x0}–{x1} / y {y0}–{y1}  "
            f"({x1 - x0}×{y1 - y0}px)\n"
            f"同一根镜条 #{stat.lens_index} · 参考行 y={stat.ref_y}\n"
            f"分界线 x={stat.bounds_at_ref[0]:.2f} … "
            f"{stat.bounds_at_ref[1]:.2f} (宽 {pitch:.3f}px, "
            f"理想每视角 {pitch / n:.3f}px)")
        self.bar.set_data(stat.counts, n)

        self.table.setRowCount(n)
        ideal_share = 1.0 / n
        rows = max(1, y1 - y0)
        for vid in range(n):
            cnt = stat.counts[vid] if vid < len(stat.counts) else 0
            share = cnt / stat.total if stat.total else 0.0
            width_px = cnt / rows  # 沿选区高度平均的横截面宽度
            vals = [self._view_label(vid), str(cnt), f"{width_px:.2f}",
                    f"{width_px / p.dpi:.4f}", f"{share * 100:.1f}%",
                    f"{(share - ideal_share) * 100:+.1f}pp"]
            for col, txt in enumerate(vals):
                item = QtWidgets.QTableWidgetItem(txt)
                if col == 0:
                    item.setIcon(color_icon(vid))
                    item.setToolTip(txt)
                if col >= 1:
                    item.setTextAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
                self.table.setItem(vid, col, item)

        lines = []
        for vid, a, b, length in stat.runs:
            lines.append(f"视角{vid + 1}  x {a:4d}–{b:<4d}  {length}px")
        if not lines:
            lines = ["(该选区没有覆盖完整像素)"]
        order = p.normalized_order(n)
        lines.append("")
        lines.append("相位段顺序: " + " | ".join(f"段{k + 1}→视{v + 1}"
                                                for k, v in enumerate(order)))
        self.txt_runs.setPlainText("\n".join(lines))

        # 倾斜镜条平行四边形高亮
        ya, yb = float(y0), float(y1)
        m = stat.lens_index
        h = c["h"]
        bl_t = core.boundary_x(m, ya, h, pitch, p)
        br_t = core.boundary_x(m + 1, ya, h, pitch, p)
        bl_b = core.boundary_x(m, yb, h, pitch, p)
        br_b = core.boundary_x(m + 1, yb, h, pitch, p)
        self.canvas.set_highlight_polygon(
            [(bl_t, ya), (br_t, ya), (br_b, yb), (bl_b, yb)])

    # ==================================================================
    # 校验窗口
    # ==================================================================
    def bundle_provider(self) -> dict:
        b = dict(self._cache)
        b["height"] = b.get("h")
        b["width"] = b.get("w")
        return b

    def open_validation(self) -> None:
        if self._dlg is None:
            self._dlg = ValidationDialog(self.bundle_provider, self.load_preset, self)
        self._dlg.refresh_all()
        self._dlg.show()
        self._dlg.raise_()

    # ==================================================================
    # 导出 / 持久化
    # ==================================================================
    def _ask_save(self, title: str, default: str) -> str | None:
        path, _ = QtWidgets.QFileDialog.getSaveFileName(
            self, title, default, "PNG (*.png)")
        return path or None

    def export_interlaced(self) -> None:
        if not self._cache:
            return
        h, w = self._cache["h"], self._cache["w"]
        path = self._ask_save("导出交错原像素 PNG", f"interlaced_{w}x{h}.png")
        if not path:
            return
        save_png(self._cache["inter"], path, dpi=self.params.dpi)
        self.statusBar().showMessage(
            f"已导出 {w}×{h} 原像素(未缩放): {path}", 5000)
        QtWidgets.QMessageBox.information(
            self, "导出完成",
            f"{path}\n\n实际像素 {w}×{h}, DPI 元数据 {self.params.dpi:g}。\n"
            "缩略图清晰度没有影响该文件的取样或尺寸。")

    def export_layer(self) -> None:
        if not self._cache:
            return
        path = self._ask_save("导出来源图层 PNG", "source_layer.png")
        if not path:
            return
        save_png(self._cache["layer"], path, dpi=self.params.dpi)
        self.statusBar().showMessage(f"来源图层已导出: {path}", 5000)

    def export_calibration(self) -> None:
        if not self._cache:
            return
        w = self._cache["w"]
        path = self._ask_save("导出校准条 PNG", f"calibration_strip_w{w}.png")
        if not path:
            return
        strip = build_calibration_strip(w, self.params, self._cache["n"],
                                        dpi=self.params.dpi)
        save_qimage_png(strip, path, dpi=self.params.dpi)
        self.statusBar().showMessage(f"校准条已导出: {path}", 5000)

    def save_params(self) -> None:
        path, _ = QtWidgets.QFileDialog.getSaveFileName(
            self, "保存参数", "lenticular_project.json", "JSON (*.json)")
        if not path:
            return
        pf = ProjectFile(params=self.params, views=self.sources,
                         preview_max_side=self.preview_max_side)
        pf.save_json(path)
        self.statusBar().showMessage(f"参数已保存: {path}", 5000)

    def load_params(self) -> None:
        path, _ = QtWidgets.QFileDialog.getOpenFileName(
            self, "加载参数", "", "JSON (*.json)")
        if not path:
            return
        try:
            pf = ProjectFile.load_json(path)
            self.apply_project(pf)
        except Exception as e:  # noqa: BLE001
            QtWidgets.QMessageBox.critical(self, "加载失败", f"{path}\n{e}")
            return
        self.statusBar().showMessage(f"已加载参数: {path}", 5000)

    def apply_project(self, pf: ProjectFile) -> None:
        views: list[np.ndarray] = []
        sources: list[ViewSource] = []
        target_shape = None
        for src in pf.views:
            try:
                if src.kind == "file" and src.path and Path(src.path).exists():
                    arr = load_png_rgba(src.path)
                else:
                    arr = None
            except Exception:  # noqa: BLE001
                arr = None
            if arr is None:
                arr = make_sample(src.sample_index)
                if src.kind == "file":
                    src = ViewSource(kind="sample",
                                     sample_index=src.sample_index,
                                     label=src.label or "缺失文件→样例")
            if target_shape is None:
                target_shape = arr.shape[:2]
            elif arr.shape[:2] != target_shape:
                continue
            views.append(arr)
            sources.append(src)
        if not (2 <= len(views) <= 4):
            views = make_samples(3)
            sources = [ViewSource(kind="sample", sample_index=i) for i in range(3)]
        self.views = views
        self.sources = sources
        self.params = pf.params
        self.preview_max_side = pf.preview_max_side
        self._selection = None
        self._small_views = None
        self.canvas._has_fit_once = False
        self.canvas.set_selection_rect(None)
        self._refresh_view_lists()
        self._sync_controls_from_params()
        self.rebuild_all()


def main() -> int:
    import sys
    app = QtWidgets.QApplication(sys.argv)
    app.setApplicationName("LenticularTool")
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
