"""PySide6 手调对照页。

界面结构（自上而下）：
  1. 工具条：样例选择 / 导入 wav / 导出 / 重新分析
  2. 波形总览：可拖动选区决定分析片段
  3. 主区左右分栏：左=候选峰列表 + 参数；右=互相关图 / 局部波形重叠 / 时变图
"""

from __future__ import annotations

import os
import numpy as np
import pyqtgraph as pg
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor, QPen
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QFrame,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSlider,
    QSpinBox,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from .dsp import Peak, TdoaResult, fractional_shift, read_wav
from .models import DriftResult
from .report import analyze_selection, build_report, export_alignment
from .synth import PRESET_KEYS, Sample, make_preset

# ---------------------------------------------------------------------------
# 配色：深色表面 + 参考调色板前 3 个分类色（已按 dark 表面校验）
# ---------------------------------------------------------------------------

SURFACE = "#1a1a19"
PAGE = "#0d0d0d"
INK = "#f0efec"
INK_2 = "#c3c2b7"
MUTED = "#898781"
GRID = "#2c2c2a"
AXIS = "#383835"
SERIES_1 = "#3987e5"   # ch0
SERIES_2 = "#d95926"   # ch1
SERIES_3 = "#199e70"   # 对齐后 / 选区
WARN = "#fab219"
CRIT = "#d03b3b"

pg.setConfigOptions(antialias=True, background=SURFACE, foreground=MUTED, imageAxisOrder="row-major")


def _pen(color: str, width: float = 1.6, style=Qt.SolidLine) -> QPen:
    p = pg.mkPen(color, width=width)
    p.setStyle(style)
    return p


def _add_legend(plot: pg.PlotWidget) -> None:
    """pyqtgraph 默认的图例背景在深色下对比度不足，这里统一换成一档更实的底色。"""
    legend = plot.addLegend(offset=(8, 8), labelTextColor=INK_2)
    legend.setBrush(pg.mkBrush(26, 26, 25, 220))
    legend.setPen(_pen(AXIS, 1))


def _style_plot(plot: pg.PlotWidget, title: str, xlabel: str = "", ylabel: str = "") -> None:
    plot.setBackground(SURFACE)
    plot.showGrid(x=True, y=True, alpha=0.18)
    for name in ("left", "bottom", "right", "top"):
        ax = plot.getAxis(name)
        ax.setPen(_pen(AXIS, 1))
        ax.setTextPen(_pen(MUTED, 1))
        ax.enableAutoSIPrefix(False)  # 不要 x(0.001) 这类缩放后缀
    plot.setTitle(title, color=INK_2, size="10pt")
    if xlabel:
        plot.setLabel("bottom", xlabel, color=MUTED)
    if ylabel:
        plot.setLabel("left", ylabel, color=MUTED)
    item = plot.getPlotItem()
    item.setMenuEnabled(False)
    item.hideButtons()
    plot.setMouseEnabled(x=True, y=False)
    plot.setClipToView(True)
    # 固定 y 轴范围，避免 setData 之后自动缩放把手工范围覆盖掉
    item.getViewBox().setAutoVisible(y=False)
    item.getViewBox().enableAutoRange(axis=pg.ViewBox.XAxis, enable=False)
    item.getViewBox().enableAutoRange(axis=pg.ViewBox.YAxis, enable=False)


def _fmt_lag(v: float) -> str:
    return f"{v:+.3f}"


# ---------------------------------------------------------------------------
# 波形总览（可拖动选区）
# ---------------------------------------------------------------------------


class OverviewPlot(pg.PlotWidget):
    selectionChanged = Signal(float, float)   # start_s, dur_s

    def __init__(self):
        super().__init__()
        _style_plot(self, "双通道总览 · 拖动选区选择片段", "时间 (s)", "幅度")
        self._sample: Sample | None = None
        self._region: pg.LinearRegionItem | None = None
        self._guard = False

        self.curve0 = self.plot(pen=_pen(SERIES_1, 1.1), name="ch0")
        self.curve1 = self.plot(pen=_pen(SERIES_2, 1.1), name="ch1")
        self.setYRange(-1.05, 1.05, padding=0)
        _add_legend(self)

    def set_sample(self, sample: Sample, start_s: float, dur_s: float) -> None:
        self._sample = sample
        # 概览只需包络，降采样到屏幕宽度即可
        n = sample.ch0.size
        step = max(1, n // 6000)
        t = np.arange(0, n, step) / sample.sr
        self.curve0.setData(t, sample.ch0[::step])
        self.curve1.setData(t, sample.ch1[::step])
        self.setXRange(0, n / sample.sr, padding=0)
        if self._region is None:
            self._region = pg.LinearRegionItem(
                values=(start_s, start_s + dur_s),
                brush=pg.mkBrush(25, 158, 112, 40),
                hoverBrush=pg.mkBrush(25, 158, 112, 60),
                pen=_pen(SERIES_3, 1.2),
                movable=True,
            )
            self._region.setZValue(10)
            self.addItem(self._region)
            self._region.sigRegionChangeFinished.connect(self._emit_region)
        else:
            self._guard = True
            self._region.setRegion((start_s, start_s + dur_s))
            self._guard = False

    def selection(self) -> tuple[float, float]:
        if self._region is None:
            return 0.0, 0.0
        a, b = self._region.getRegion()
        return float(a), float(max(1e-3, b - a))

    def _emit_region(self) -> None:
        if self._guard:
            return
        a, b = self._region.getRegion()
        self.selectionChanged.emit(float(a), float(max(1e-3, b - a)))


# ---------------------------------------------------------------------------
# 局部波形重叠（可拖动小数对齐量）
# ---------------------------------------------------------------------------


class OverlapPlot(pg.PlotWidget):
    alignChanged = Signal(float)               # 新的对齐量（采样）

    def __init__(self):
        super().__init__()
        _style_plot(self, "局部波形重叠 · Shift+拖动可小数对齐", "相对片段起点 (采样)", "幅度")
        self.curve_a = self.plot(pen=_pen(SERIES_1, 1.5), name="ch0（参考）")
        self.curve_b = self.plot(pen=_pen(SERIES_2, 1.5), name="ch1（对齐后）")
        self.res_curve = self.plot(pen=_pen(MUTED, 1.0), name="残差 (ch0-ch1)")
        _add_legend(self)
        self.show_residual = True

        self._ch0 = np.zeros(0)
        self._ch1 = np.zeros(0)
        self._polarity = 1
        self._amount = 0.0
        self._sr = 48000
        self._view = (0, 1000)
        self._dragging = False
        self._y_span = 0.0
        self._drag_x0 = 0.0
        self._drag_amount0 = 0.0
        self.setYRange(-1.05, 1.05)

    def set_data(self, ch0: np.ndarray, ch1: np.ndarray, sr: int, polarity: int) -> None:
        self._ch0 = np.asarray(ch0, dtype=np.float64)
        self._ch1 = np.asarray(ch1, dtype=np.float64)
        self._sr = int(sr)
        self._polarity = int(polarity)

    def set_view(self, start: int, count: int) -> None:
        start = max(0, int(start))
        count = int(max(16, count))
        self._view = (start, start + count)
        self._render()

    def set_align(self, amount: float) -> None:
        self._amount = float(amount)
        self._render()

    def align_amount(self) -> float:
        return self._amount

    def set_residual_visible(self, on: bool) -> None:
        self.show_residual = on
        self.res_curve.setVisible(on)
        self._render()

    def set_polarity(self, polarity: int) -> None:
        self._polarity = int(polarity)
        self._render()

    def _render(self) -> None:
        if self._ch0.size == 0:
            return
        s, e = self._view
        x = np.arange(s, e, dtype=np.float64)
        a = self._ch0[s:e]
        # ch1 在原始坐标里是“晚到 amount”，对齐后应左移 amount
        b_shifted = fractional_shift(self._ch1, -self._amount) * (1 if self._polarity >= 0 else -1)
        b = b_shifted[s:e]
        self.curve_a.setData(x, a)
        self.curve_b.setData(x, b)
        self.res_curve.setData(x, a - b)
        self.setXRange(s, e, padding=0)
        span = max(np.max(np.abs(a)) if a.size else 1.0, np.max(np.abs(b)) if b.size else 1.0, 0.05)
        if abs(self._y_span - span) > 0.02:
            self._y_span = span
            self.setYRange(-span * 1.15, span * 1.15, padding=0)

    def mousePressEvent(self, ev):
        if ev.button() == Qt.LeftButton and ev.modifiers() & Qt.ShiftModifier:
            self._dragging = True
            self._drag_x0 = self.mapToScene(ev.pos()).x()
            self._drag_amount0 = self._amount
            ev.accept()
            return
        super().mousePressEvent(ev)

    def mouseMoveEvent(self, ev):
        if self._dragging:
            dx = self.mapToScene(ev.pos()).x() - self._drag_x0
            # 场景坐标 1px 对应多少采样
            view = self.getViewBox().viewRect()
            if view.width() > 0:
                per_px = view.width() / max(1, self.width())
                self._amount = self._drag_amount0 + dx * per_px
                self.alignChanged.emit(self._amount)
                self._render()
            ev.accept()
            return
        super().mouseMoveEvent(ev)

    def mouseReleaseEvent(self, ev):
        if self._dragging:
            self._dragging = False
            ev.accept()
            return
        super().mouseReleaseEvent(ev)

    def wheelEvent(self, ev):
        # Ctrl+滚轮 = 缩放；余下交给 pyqtgraph 平移
        super().wheelEvent(ev)


# ---------------------------------------------------------------------------
# 主窗口
# ---------------------------------------------------------------------------


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("双通道到达时差 · 手调对照台")
        self.resize(1500, 980)
        self.sample: Sample | None = None
        self.source_label = "内置样例"
        self.imported_truth: float | None = None
        self.analysis: dict | None = None
        self.report: dict | None = None
        self.selected_peak_lag: int | None = None
        self._view_pinned = False
        self.align_amount = 0.0
        self._manual_align = False
        self._updating = False

        self._build_ui()
        self._apply_style()
        self.load_preset("clean")

    # -- UI ----------------------------------------------------------------

    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(14, 12, 14, 12)
        root.setSpacing(10)

        root.addWidget(self._build_toolbar())

        self.overview = OverviewPlot()
        self.overview.setMinimumHeight(170)
        self.overview.selectionChanged.connect(self._on_region_changed)
        root.addWidget(self.overview)

        split = QSplitter(Qt.Horizontal)
        split.setChildrenCollapsible(False)
        split.addWidget(self._build_left_panel())
        split.addWidget(self._build_right_panel())
        split.setStretchFactor(0, 0)
        split.setStretchFactor(1, 1)
        split.setSizes([460, 1040])
        root.addWidget(split, 1)

    def _build_toolbar(self) -> QWidget:
        bar = QFrame()
        bar.setObjectName("toolbar")
        lay = QHBoxLayout(bar)
        lay.setContentsMargins(10, 8, 10, 8)
        lay.setSpacing(8)

        lay.addWidget(QLabel("样例"))
        self.preset_box = QComboBox()
        for key, (name, _fn) in PRESET_KEYS.items():
            self.preset_box.addItem(name, key)
        self.preset_box.currentIndexChanged.connect(
            lambda _i: self.load_preset(self.preset_box.currentData())
        )
        lay.addWidget(self.preset_box)

        self.btn_import = QPushButton("导入双通道 wav…")
        self.btn_import.clicked.connect(self.import_wav)
        lay.addWidget(self.btn_import)

        self.lbl_truth = QLabel("参考真值")
        lay.addWidget(self.lbl_truth)
        self.truth_edit = QLineEdit()
        self.truth_edit.setPlaceholderText("可选，单位：采样")
        self.truth_edit.setFixedWidth(130)
        self.truth_edit.setToolTip("已知时差（采样点，正值=ch1 晚到）。留空则不计算误差。")
        self.truth_edit.editingFinished.connect(self._on_truth_edited)
        lay.addWidget(self.truth_edit)

        lay.addStretch(1)
        self.btn_analyze = QPushButton("重新分析")
        self.btn_analyze.setObjectName("primary")
        self.btn_analyze.clicked.connect(lambda: self.analyze(reset_selection=False))
        lay.addWidget(self.btn_analyze)

        self.btn_export = QPushButton("导出对齐音频 + 报告")
        self.btn_export.clicked.connect(self.export)
        lay.addWidget(self.btn_export)

        return bar

    def _build_left_panel(self) -> QWidget:
        panel = QWidget()
        lay = QVBoxLayout(panel)
        lay.setContentsMargins(0, 0, 8, 0)
        lay.setSpacing(10)

        # 结论卡
        card = QGroupBox("检测结论")
        cl = QVBoxLayout(card)
        cl.setSpacing(4)
        self.lbl_headline = QLabel("—")
        self.lbl_headline.setObjectName("headline")
        self.lbl_headline.setTextInteractionFlags(Qt.TextSelectableByMouse)
        cl.addWidget(self.lbl_headline)
        self.lbl_sub = QLabel("—")
        self.lbl_sub.setObjectName("sub")
        self.lbl_sub.setWordWrap(True)
        cl.addWidget(self.lbl_sub)
        self.lbl_badges = QLabel("")
        self.lbl_badges.setWordWrap(True)
        cl.addWidget(self.lbl_badges)
        lay.addWidget(card)

        # 候选峰
        cand = QGroupBox("候选时差（点击选用）")
        cv = QVBoxLayout(cand)
        self.table = QTableWidget(0, 6)
        self.table.setHorizontalHeaderLabels(["lag", "小数", "相关", "置信", "类别", ""])
        self.table.verticalHeader().setVisible(False)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.setAlternatingRowColors(True)
        hh = self.table.horizontalHeader()
        for col in range(5):
            hh.setSectionResizeMode(col, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(5, QHeaderView.Stretch)
        self.table.itemSelectionChanged.connect(self._on_candidate_selected)
        self.table.setMinimumHeight(190)
        cv.addWidget(self.table)
        self.lbl_cand_hint = QLabel("")
        self.lbl_cand_hint.setObjectName("hint")
        self.lbl_cand_hint.setWordWrap(True)
        cv.addWidget(self.lbl_cand_hint)
        lay.addWidget(cand)

        # 对齐控制
        align = QGroupBox("小数对齐预览")
        al = QVBoxLayout(align)
        al.setSpacing(6)
        row = QHBoxLayout()
        row.addWidget(QLabel("对齐量（采样）"))
        self.align_spin = QDoubleSpinBox()
        self.align_spin.setDecimals(4)
        self.align_spin.setRange(-100000, 100000)
        self.align_spin.setSingleStep(0.05)
        self.align_spin.setKeyboardTracking(False)
        self.align_spin.valueChanged.connect(self._on_align_spin)
        row.addWidget(self.align_spin, 1)
        self.btn_snap = QPushButton("回到检测值")
        self.btn_snap.clicked.connect(self._snap_align)
        row.addWidget(self.btn_snap)
        al.addLayout(row)

        self.slider = QSlider(Qt.Horizontal)
        self.slider.setRange(-5000, 5000)     # 1/1000 采样，相对检测值的偏移
        self.slider.setSingleStep(1)
        self.slider.setPageStep(50)
        self.slider.setToolTip("相对检测值的偏移，刻度 1/1000 采样（±5 采样）")
        self.slider.valueChanged.connect(self._on_slider)
        al.addWidget(self.slider)

        nudge = QHBoxLayout()
        nudge.addWidget(QLabel("微调"))
        for label, delta in (("−1", -1.0), ("−0.1", -0.1), ("+0.1", 0.1), ("+1", 1.0)):
            b = QPushButton(label)
            b.setFixedWidth(50)
            b.clicked.connect(lambda _c=False, d=delta: self._nudge(d))
            nudge.addWidget(b)
        nudge.addStretch(1)
        al.addLayout(nudge)

        self.lbl_align_info = QLabel("")
        self.lbl_align_info.setObjectName("hint")
        self.lbl_align_info.setWordWrap(True)
        al.addWidget(self.lbl_align_info)

        prow = QHBoxLayout()
        self.chk_residual = QCheckBox("显示残差")
        self.chk_residual.setChecked(True)
        prow.addWidget(self.chk_residual)
        prow.addStretch(1)
        prow.addWidget(QLabel("极性"))
        self.polarity_box = QComboBox()
        self.polarity_box.addItem("自动", None)
        self.polarity_box.addItem("同相 (+1)", 1)
        self.polarity_box.addItem("反相 (-1)", -1)
        self.polarity_box.currentIndexChanged.connect(self._on_polarity)
        prow.addWidget(self.polarity_box)
        al.addLayout(prow)
        lay.addWidget(align)

        # 参数
        params = QGroupBox("检测参数")
        pf = QFormLayout(params)
        pf.setLabelAlignment(Qt.AlignRight)
        self.spin_maxlag = QDoubleSpinBox()
        self.spin_maxlag.setRange(1, 2000)
        self.spin_maxlag.setDecimals(1)
        self.spin_maxlag.setValue(50.0)
        self.spin_maxlag.setSuffix(" ms")
        pf.addRow("最大时差", self.spin_maxlag)

        self.spin_topk = QSpinBox()
        self.spin_topk.setRange(1, 12)
        self.spin_topk.setValue(6)
        pf.addRow("候选数量", self.spin_topk)

        self.spin_sep = QDoubleSpinBox()
        self.spin_sep.setRange(0.1, 50.0)
        self.spin_sep.setDecimals(2)
        self.spin_sep.setValue(3.0)
        self.spin_sep.setSuffix(" ms")
        pf.addRow("峰最小间隔", self.spin_sep)

        self.spin_drift = QDoubleSpinBox()
        self.spin_drift.setRange(20, 2000)
        self.spin_drift.setDecimals(0)
        self.spin_drift.setValue(200)
        self.spin_drift.setSuffix(" ms")
        pf.addRow("时变窗长", self.spin_drift)

        lay.addWidget(params)
        lay.addStretch(1)
        return panel

    def _build_right_panel(self) -> QWidget:
        panel = QWidget()
        lay = QVBoxLayout(panel)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(8)

        self.corr_plot = pg.PlotWidget()
        _style_plot(self.corr_plot, "互相关（归一化）· 候选峰", "时差 lag（采样）", "相关")
        self.corr_plot.setMinimumHeight(220)
        self.corr_curve = self.corr_plot.plot(pen=_pen(SERIES_1, 1.3))
        self.corr_peaks = pg.ScatterPlotItem(size=11, pen=None)
        self.corr_plot.addItem(self.corr_peaks)
        self.corr_label = pg.TextItem("", color=INK_2, anchor=(1, 0.5))
        self.corr_plot.addItem(self.corr_label)
        self.corr_plot.scene().sigMouseMoved.connect(self._on_corr_hover)
        lay.addWidget(self.corr_plot, 3)

        self.overlap = OverlapPlot()
        self.overlap.setMinimumHeight(260)
        self.overlap.alignChanged.connect(self._on_drag_align)
        lay.addWidget(self.overlap, 4)
        self.chk_residual.toggled.connect(self.overlap.set_residual_visible)

        view_row = QHBoxLayout()
        view_row.addWidget(QLabel("查看位置（采样）"))
        self.spin_view_start = QSpinBox()
        self.spin_view_start.setRange(0, 10_000_000)
        self.spin_view_start.setSingleStep(256)
        self.spin_view_start.valueChanged.connect(self._on_view_edited)
        view_row.addWidget(self.spin_view_start)
        view_row.addWidget(QLabel("窗长"))
        self.spin_view_len = QSpinBox()
        self.spin_view_len.setRange(64, 200_000)
        self.spin_view_len.setSingleStep(128)
        self.spin_view_len.setValue(2048)
        self.spin_view_len.valueChanged.connect(self._on_view_edited)
        view_row.addWidget(self.spin_view_len)
        self.btn_jump_peak = QPushButton("跳到冲击处")
        self.btn_jump_peak.clicked.connect(self._jump_to_peak)
        view_row.addWidget(self.btn_jump_peak)
        view_row.addWidget(QLabel("（Shift+拖动 ch1 微调）"))
        view_row.addStretch(1)
        lay.addLayout(view_row)

        self.drift_plot = pg.PlotWidget()
        _style_plot(self.drift_plot, "局部时差随时间变化 · 区分反相/时间漂移", "片段内时间 (s)", "时差 (采样)")
        self.drift_plot.setMinimumHeight(180)
        self.drift_lo_curve = pg.PlotDataItem(pen=None)
        self.drift_hi_curve = pg.PlotDataItem(pen=None)
        self.drift_band = pg.FillBetweenItem(
            self.drift_lo_curve, self.drift_hi_curve,
            brush=pg.mkBrush(57, 135, 229, 40),
        )
        self.drift_plot.addItem(self.drift_band)
        self.drift_plot.addItem(self.drift_lo_curve)
        self.drift_plot.addItem(self.drift_hi_curve)
        self.drift_curve = self.drift_plot.plot(pen=_pen(SERIES_1, 1.6), symbol="o", symbolSize=6,
                                                symbolBrush=SERIES_1, symbolPen=None)
        self.drift_zero = pg.InfiniteLine(angle=0, pen=_pen(AXIS, 1, Qt.DashLine))
        self.drift_plot.addItem(self.drift_zero)
        lay.addWidget(self.drift_plot, 2)

        rep_row = QHBoxLayout()
        self.lbl_report = QLabel("—")
        self.lbl_report.setObjectName("hint")
        self.lbl_report.setWordWrap(True)
        rep_row.addWidget(self.lbl_report, 1)
        lay.addLayout(rep_row)
        return panel

    def _apply_style(self) -> None:
        self.setStyleSheet(
            f"""
            QWidget {{ background: {PAGE}; color: {INK}; font-size: 13px; }}
            QMainWindow {{ background: {PAGE}; }}
            #toolbar, QGroupBox, QTableWidget, QTextEdit, QLineEdit,
            QComboBox, QSpinBox, QDoubleSpinBox, QPushButton {{
                background: {SURFACE}; border: 1px solid {AXIS}; border-radius: 6px;
            }}
            #toolbar {{ border-radius: 8px; }}
            QGroupBox {{ margin-top: 12px; padding: 10px 8px 8px 8px; font-weight: 600; color: {INK_2}; }}
            QGroupBox::title {{ subcontrol-origin: margin; left: 10px; padding: 0 4px; }}
            QLabel#headline {{ font-size: 26px; font-weight: 700; color: {INK}; }}
            QLabel#sub {{ color: {INK_2}; }}
            QLabel#hint {{ color: {MUTED}; font-size: 12px; }}
            QLineEdit, QComboBox, QSpinBox, QDoubleSpinBox {{ padding: 4px 6px; color: {INK}; }}
            QComboBox QAbstractItemView {{ background: {SURFACE}; selection-background-color: {SERIES_1}; }}
            QPushButton {{ padding: 6px 12px; color: {INK}; }}
            QPushButton:hover {{ border-color: {SERIES_1}; }}
            QPushButton#primary {{ background: {SERIES_1}; border-color: {SERIES_1}; color: white; font-weight: 600; }}
            QPushButton:disabled {{ color: {MUTED}; }}
            QTableWidget {{ gridline-color: {GRID}; alternate-background-color: #202020; }}
            QHeaderView::section {{ background: #232322; color: {INK_2}; border: none; padding: 5px; }}
            QTableWidget::item:selected {{ background: {SERIES_1}; color: white; }}
            QSlider::groove:horizontal {{ height: 4px; background: {AXIS}; border-radius: 2px; }}
            QSlider::handle:horizontal {{ width: 14px; margin: -6px 0; border-radius: 7px; background: {SERIES_1}; }}
            QCheckBox {{ spacing: 6px; }}
            QSplitter::handle {{ background: {PAGE}; }}
            """
        )

    # -- 数据加载 ----------------------------------------------------------

    def load_preset(self, key: str) -> None:
        try:
            sample = make_preset(key)
        except Exception as exc:  # pragma: no cover - 防御性
            QMessageBox.critical(self, "样例生成失败", str(exc))
            return
        self.sample = sample
        self.source_label = f"内置样例：{sample.name}"
        self.imported_truth = sample.truth_delay
        self.truth_edit.setText("" if self.imported_truth is None else f"{self.imported_truth:g}")
        self.preset_box.blockSignals(True)
        idx = self.preset_box.findData(key)
        if idx >= 0:
            self.preset_box.setCurrentIndex(idx)
        self.preset_box.blockSignals(False)
        st, dur = sample.selection
        self.overview.set_sample(sample, st, dur)
        self.selected_peak_lag = None
        self._manual_align = False
        self._view_pinned = False
        self.analyze(reset_selection=True, start_s=st, dur_s=dur)

    def import_wav(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "选择双通道 wav", "", "WAV 音频 (*.wav)")
        if not path:
            return
        err = self.load_wav_file(path, show_errors=True)
        if err:
            return

    def load_wav_file(self, path: str, show_errors: bool = False) -> str | None:
        """载入双通道 wav；成功返回 None，失败返回错误说明。"""
        try:
            data, sr = read_wav(path)
        except Exception as exc:
            msg = f"{exc}\n\n仅支持 8/16/32-bit PCM wav。"
            if show_errors:
                QMessageBox.critical(self, "无法读取 wav", msg)
            return msg
        if data.shape[1] < 2:
            msg = "请选择包含两路声音的 wav；当前文件只有 1 个通道。"
            if show_errors:
                QMessageBox.warning(self, "只有单通道", msg)
            return msg
        ch0 = data[:, 0].copy()
        ch1 = data[:, 1].copy()
        n = min(ch0.size, ch1.size)
        sample = Sample(
            name=os.path.basename(path),
            description=f"导入文件：{path}（使用前两个通道）",
            ch0=ch0[:n],
            ch1=ch1[:n],
            sr=sr,
            truth_delay=None,
            truth_polarity=1,
            truth_snr_db=None,
            selection=(0.0, min(n / sr, 1.0)),
            meta={"kind": "file"},
        )
        self.sample = sample
        self.source_label = f"导入：{os.path.basename(path)}"
        self.imported_truth = None
        self.truth_edit.setText("")
        self.overview.set_sample(sample, *sample.selection)
        self.selected_peak_lag = None
        self._manual_align = False
        self._view_pinned = False
        self.preset_box.blockSignals(True)
        self.preset_box.setCurrentIndex(-1)
        self.preset_box.blockSignals(False)
        self.analyze(reset_selection=True, start_s=sample.selection[0], dur_s=sample.selection[1])
        return None

    # -- 分析 --------------------------------------------------------------

    def analyze(self, reset_selection: bool = False, start_s: float | None = None,
                dur_s: float | None = None) -> None:
        if self.sample is None:
            return
        if reset_selection or start_s is None:
            start_s, dur_s = self.overview.selection()
        if dur_s is None or dur_s <= 0:
            start_s, dur_s = 0.0, min(self.sample.duration, 1.0)
        force_pol = self.polarity_box.currentData()

        try:
            analysis = analyze_selection(
                self.sample,
                start_s=start_s,
                dur_s=dur_s,
                max_lag_ms=self.spin_maxlag.value(),
                top_k=self.spin_topk.value(),
                min_sep_ms=self.spin_sep.value(),
                force_polarity=force_pol,
                drift_win_ms=self.spin_drift.value(),
                selected_lag=self.selected_peak_lag,
            )
        except Exception as exc:
            QMessageBox.critical(self, "分析失败", str(exc))
            return
        self.analysis = analysis
        self._refresh_after_analysis()

    def _refresh_after_analysis(self) -> None:
        if self.analysis is None:
            return
        self._updating = True
        try:
            res: TdoaResult = self.analysis["result"]
            sel: Peak = self.analysis["selected"]
            drift: DriftResult = self.analysis["drift"]
            ch0 = self.analysis["ch0"]
            ch1 = self.analysis["ch1"]

            self.overlap.set_data(ch0, ch1, res.sr, res.polarity)
            self.spin_view_start.blockSignals(True)
            self.spin_view_start.setRange(0, max(0, ch0.size - 16))
            self.spin_view_start.blockSignals(False)
            self.spin_view_len.setMaximum(max(64, ch0.size))
            if self.spin_view_len.value() > ch0.size:
                self.spin_view_len.setValue(min(ch0.size, 2048))
            if not self._view_pinned:
                self._jump_to_peak()
            self._update_overlap_view()

            # 对齐量：默认跟随所选候选；用户手调过则保持
            if not self._manual_align:
                self.align_amount = float(sel.refined_lag)
                self.align_spin.setValue(self.align_amount)
                self._sync_slider()
            self.overlap.set_align(self.align_amount)

            self._fill_candidates(res)
            self._draw_correlogram(res, sel)
            self._draw_drift(drift)
            self._update_headline(res, sel, drift)
            self._update_report_line()
        finally:
            self._updating = False

    def _fill_candidates(self, res: TdoaResult) -> None:
        self.table.blockSignals(True)
        self.table.setRowCount(len(res.peaks))
        sel_lag = self.analysis["selected"].lag if self.analysis else res.main_peak.lag
        for row, p in enumerate(res.peaks):
            vals = [f"{p.lag:+d}", _fmt_lag(p.refined_lag), f"{p.score:.3f}",
                    f"{p.confidence:.2f}", p.label]
            for col, txt in enumerate(vals):
                item = QTableWidgetItem(txt)
                if col in (0, 2, 3):
                    item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                if p.lag == sel_lag:
                    f = item.font()
                    f.setBold(True)
                    item.setFont(f)
                if p.ambiguous:
                    item.setForeground(QColor(WARN))
                else:
                    item.setForeground(QColor(INK))
                self.table.setItem(row, col, item)
            bar = QTableWidgetItem("▇" * max(1, int(round(p.confidence * 10))))
            bar.setForeground(QColor(SERIES_3 if p.confidence >= 0.45 else MUTED))
            self.table.setItem(row, 5, bar)
            if p.lag == sel_lag:
                self.table.selectRow(row)
        self.table.blockSignals(False)

        amb = [p for p in res.peaks[1:] if p.ambiguous]
        if amb:
            self.lbl_cand_hint.setText(
                "⚠ 有近似等高候选：单击表格行切换，波形会按所选候选重新对齐。"
            )
            self.lbl_cand_hint.setStyleSheet(f"color: {WARN};")
        else:
            self.lbl_cand_hint.setText("单击任一行可改用该候选作为对齐量。")
            self.lbl_cand_hint.setStyleSheet("")

    def _draw_correlogram(self, res: TdoaResult, sel: Peak) -> None:
        self.corr_curve.setData(res.lags, res.correlogram)
        xs, ys, brushes, pens, sizes = [], [], [], [], []
        for i, p in enumerate(res.peaks):
            color = SERIES_2 if p.lag == sel.lag else (WARN if p.ambiguous else SERIES_1)
            size = 13 if p.lag == sel.lag else 11
            if p.score < 0.05 and i > 0:
                # 接近噪声的候选仍标出，但用小空心点，避免误导
                xs.append(p.lag); ys.append(max(0.0, p.score))
                brushes.append(pg.mkBrush(SURFACE))
                pens.append(pg.mkPen(MUTED, width=1.2))
                sizes.append(6)
                continue
            xs.append(p.lag)
            ys.append(p.score)
            brushes.append(pg.mkBrush(color))
            pens.append(pg.mkPen(SURFACE, width=1.5))
            sizes.append(size)
        self.corr_peaks.setData(xs, ys, brush=brushes, pen=pens, size=sizes)
        top = res.peaks[0]
        text = f"主峰 {top.lag:+d}（{top.confidence:.2f}）"
        if sel.lag != top.lag:
            text = f"已选 {sel.lag:+d} · 主峰 {top.lag:+d}"
        ymax = max(0.1, float(np.max(res.correlogram)))
        ymin = min(-0.1, float(np.min(res.correlogram)))
        mid = (ymax + ymin) / 2.0
        self.corr_label.setText(text)
        # 放到右上角，避开通常落在 lag≈0 附近的主瓣
        self.corr_label.setPos(res.lags[-1] - 0.01 * (res.lags[-1] - res.lags[0]), mid)
        self.corr_plot.setXRange(res.lags[0], res.lags[-1], padding=0.01)
        self.corr_plot.setYRange(ymin, ymax * 1.08, padding=0)

    def _draw_drift(self, drift: DriftResult) -> None:
        if drift.times.size == 0:
            self.drift_curve.setData([], [])
            self.drift_lo_curve.setData([], [])
            self.drift_hi_curve.setData([], [])
            self.drift_plot.setTitle("局部时差随时间变化 · 数据不足", color=INK_2, size="10pt")
            return
        self.drift_curve.setData(drift.times, drift.delays)
        self.drift_lo_curve.setData(drift.times, drift.lo)
        self.drift_hi_curve.setData(drift.times, drift.hi)
        state = "发现时变" if drift.changed else "未见明显时变"
        self.drift_plot.setTitle(
            f"局部时差随时间变化 · {state}（{drift.slope_per_s:+.2f} 采样/秒）",
            color=WARN if drift.changed else INK_2, size="10pt",
        )
        self.drift_plot.setXRange(float(drift.times[0]), float(drift.times[-1]) + 1e-6, padding=0.02)
        lo = min(float(np.min(drift.lo)), float(np.min(drift.delays)))
        hi = max(float(np.max(drift.hi)), float(np.max(drift.delays)))
        pad = max(1.0, (hi - lo) * 0.15)
        self.drift_plot.setYRange(lo - pad, hi + pad, padding=0)

    def _update_headline(self, res: TdoaResult, sel: Peak, drift: DriftResult) -> None:
        self.lbl_headline.setText(f"{_fmt_lag(sel.refined_lag)} 采样")
        ms = sel.refined_lag / res.sr * 1000.0
        self.lbl_sub.setText(
            f"≈ {ms:+.4f} ms · 置信 {self._conf_label(sel.confidence)}（{sel.confidence:.2f}）"
        )
        badges = []
        if res.polarity < 0:
            badges.append(f"<span style='color:{WARN}'>● 反相</span>")
        else:
            badges.append(f"<span style='color:{SERIES_3}'>● 同相</span>")
        if any(p.ambiguous for p in res.peaks[1:]):
            badges.append(f"<span style='color:{WARN}'>● 多候选待确认</span>")
        if drift.changed:
            badges.append(f"<span style='color:{CRIT}'>● 时变</span>")
        if sel is not res.main_peak:
            badges.append("<span style='color:#c3c2b7'>● 手动选用候选</span>")
        self.lbl_badges.setText("　".join(badges))

    def _conf_label(self, conf: float) -> str:
        return "高" if conf >= 0.7 else ("中" if conf >= 0.45 else "低")

    def _update_report_line(self) -> None:
        if self.analysis is None:
            return
        self.report = build_report(
            self.sample, self.analysis, self.align_amount,
            self._current_truth(), source=self.source_label,
        )
        rep = self.report
        ti = rep["truth"]
        ri = rep["reference_interval"]
        parts = [
            f"95% 参考区间 [{ri['lo']:+.2f}, {ri['hi']:+.2f}] 采样（±{ri['half_width']:.2f}）",
        ]
        if ti["known"]:
            parts.append(f"参考真值 {ti['value']:+.2f}，误差 {ti['error_samples']:+.3f} 采样（{ti['error_us']:+.1f} µs）")
            parts.append("真值在区间内" if ti["in_reference_interval"] else "真值不在区间内")
        else:
            parts.append("参考真值未填写，不计算误差")
        if rep["warnings"]:
            parts.append("注意：" + "；".join(rep["warnings"]))
        self.lbl_report.setText(" · ".join(parts))
        self._update_align_info()

    def _update_align_info(self) -> None:
        if self.analysis is None:
            return
        sel: Peak = self.analysis["selected"]
        res: TdoaResult = self.analysis["result"]
        manual = self.align_amount - sel.refined_lag
        sr = res.sr
        residual = self._residual_rms()
        txt = (
            f"对齐 {self.align_amount:+.3f} 采样 = 检测值 {sel.refined_lag:+.3f}"
            if abs(manual) < 1e-9
            else f"对齐 {self.align_amount:+.3f} 采样 = 检测值 {sel.refined_lag:+.3f} 手调 {manual:+.3f}"
            f"（{manual / sr * 1e6:+.1f} µs）"
        )
        txt += f" · 对齐后残差 RMS {residual:.4f}"
        if res.polarity < 0:
            txt += " · 已按反相补偿"
        self.lbl_align_info.setText(txt)

    def _residual_rms(self) -> float:
        if self.analysis is None:
            return 0.0
        ch0 = self.analysis["ch0"]
        ch1 = self.analysis["ch1"] * (1 if self.analysis["result"].polarity >= 0 else -1)
        aligned = fractional_shift(ch1, -self.align_amount)
        n = min(ch0.size, aligned.size)
        if n == 0:
            return 0.0
        return float(np.sqrt(np.mean((ch0[:n] - aligned[:n]) ** 2)))

    # -- 交互 --------------------------------------------------------------

    def _on_region_changed(self, start_s: float, dur_s: float) -> None:
        if self._updating or self.sample is None:
            return
        self.selected_peak_lag = None
        self._view_pinned = False
        self.analyze(reset_selection=False, start_s=start_s, dur_s=dur_s)

    def _on_candidate_selected(self) -> None:
        if self._updating or self.analysis is None:
            return
        rows = self.table.selectionModel().selectedRows()
        if not rows:
            return
        row = rows[0].row()
        peaks = self.analysis["result"].peaks
        if not (0 <= row < len(peaks)):
            return
        p = peaks[row]
        if p.lag == self.analysis["selected"].lag:
            return
        self.selected_peak_lag = p.lag
        self._manual_align = False
        self.analysis = analyze_selection(
            self.sample,
            start_s=self.analysis["start_s"],
            dur_s=self.analysis["duration_s"],
            max_lag_ms=self.spin_maxlag.value(),
            top_k=self.spin_topk.value(),
            min_sep_ms=self.spin_sep.value(),
            force_polarity=self.polarity_box.currentData(),
            drift_win_ms=self.spin_drift.value(),
            selected_lag=self.selected_peak_lag,
        )
        self.align_amount = float(self.analysis["selected"].refined_lag)
        self._refresh_after_analysis()

    def _on_align_spin(self, value: float) -> None:
        if self._updating:
            return
        self._manual_align = True
        self.align_amount = float(value)
        self.overlap.set_align(self.align_amount)
        self._sync_slider()
        self._update_report_line()

    def _detected_lag(self) -> float:
        return float(self.analysis["selected"].refined_lag) if self.analysis else 0.0

    def _on_slider(self, value: int) -> None:
        if self._updating:
            return
        self._manual_align = True
        self.align_amount = self._detected_lag() + value / 1000.0
        self._updating = True
        try:
            self.align_spin.setValue(self.align_amount)
        finally:
            self._updating = False
        self.overlap.set_align(self.align_amount)
        self._update_report_line()

    def _sync_slider(self) -> None:
        self._updating = True
        try:
            v = int(round((self.align_amount - self._detected_lag()) * 1000))
            self.slider.setValue(max(self.slider.minimum(), min(self.slider.maximum(), v)))
        finally:
            self._updating = False

    def _on_drag_align(self, amount: float) -> None:
        self._manual_align = True
        self.align_amount = float(amount)
        self._updating = True
        try:
            self.align_spin.setValue(self.align_amount)
        finally:
            self._updating = False
        self._sync_slider()
        self.overlap.set_align(self.align_amount)
        self._update_report_line()

    def _nudge(self, delta: float) -> None:
        self._manual_align = True
        self.align_spin.setValue(self.align_spin.value() + delta)
        self._sync_slider()

    def _snap_align(self) -> None:
        if self.analysis is None:
            return
        self.align_amount = float(self.analysis["selected"].refined_lag)
        self._updating = True
        try:
            self.align_spin.setValue(self.align_amount)
        finally:
            self._updating = False
        self._manual_align = False
        self._sync_slider()
        self.overlap.set_align(self.align_amount)
        self._update_report_line()

    def _on_polarity(self, _idx: int) -> None:
        if self._updating or self.sample is None or self.analysis is None:
            return
        self.selected_peak_lag = None
        self._manual_align = False
        self.analysis = analyze_selection(
            self.sample,
            start_s=self.analysis["start_s"],
            dur_s=self.analysis["duration_s"],
            max_lag_ms=self.spin_maxlag.value(),
            top_k=self.spin_topk.value(),
            min_sep_ms=self.spin_sep.value(),
            force_polarity=self.polarity_box.currentData(),
            drift_win_ms=self.spin_drift.value(),
            selected_lag=self.selected_peak_lag,
        )
        self._refresh_after_analysis()

    def _on_truth_edited(self) -> None:
        self.imported_truth = self._current_truth()
        self._update_report_line()

    def _current_truth(self) -> float | None:
        txt = self.truth_edit.text().strip()
        if not txt:
            return None
        try:
            return float(txt)
        except ValueError:
            return self.imported_truth

    def _update_overlap_view(self) -> None:
        if self.analysis is None:
            return
        start = self.spin_view_start.value()
        length = self.spin_view_len.value()
        self.overlap.set_view(start, min(length, self.analysis["ch0"].size - start))

    def _on_view_edited(self) -> None:
        if not self._updating:
            self._view_pinned = True
        self._update_overlap_view()

    def _jump_to_peak(self) -> None:
        if self.analysis is None:
            return
        ch0 = self.analysis["ch0"]
        length = self.spin_view_len.value()
        if ch0.size <= length:
            self.spin_view_start.setValue(0)
            return
        env = np.abs(ch0)
        win = max(16, length // 2)
        # 在可放置窗口的范围内寻找能量最大的起点
        kernel = np.ones(win)
        energy = np.convolve(env, kernel, mode="valid")
        best = int(np.argmax(energy))
        self.spin_view_start.setValue(max(0, min(best, ch0.size - length)))

    def _on_corr_hover(self, pos) -> None:
        if self.analysis is None:
            return
        vb = self.corr_plot.getViewBox()
        if not vb.sceneBoundingRect().contains(pos):
            return
        pt = vb.mapSceneToView(pos)
        lags = self.analysis["result"].lags
        corr = self.analysis["result"].correlogram
        if lags.size == 0:
            return
        i = int(np.clip(round(pt.x() - lags[0]), 0, lags.size - 1))
        self.corr_label.setText(f"lag={lags[i]:+d}  相关={corr[i]:.3f}")

    # -- 导出 --------------------------------------------------------------

    def export(self) -> None:
        if self.analysis is None:
            return
        out_dir = os.path.join(os.getcwd(), "out")
        os.makedirs(out_dir, exist_ok=True)
        stamp = self._next_stamp(out_dir)
        stem = f"{stamp}_{self.sample.name if self.sample else 'tdoa'}"
        # 重新计算报告，确保对齐量与真值来自最新界面状态
        self._update_report_line()
        try:
            paths = export_alignment(
                out_dir=out_dir,
                stem=stem,
                ch0=self.analysis["ch0"],
                ch1=self.analysis["ch1"],
                sr=self.analysis["sr"],
                align_amount=self.align_amount,
                polarity=self.analysis["result"].polarity,
                report=self.report,
            )
        except Exception as exc:
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        dlg = QMessageBox(self)
        dlg.setWindowTitle("已导出")
        dlg.setText("对齐音频与报告已写出：")
        dlg.setDetailedText("\n".join(f"{k}: {v}" for k, v in paths.items()))
        dlg.setInformativeText(
            f"{paths['aligned_wav']}\n{paths['report_json']}\n\n"
            "aligned.wav 的两通道已对齐（左 ch0、右 ch1），residual.wav 为差值。"
        )
        dlg.exec()

    def _next_stamp(self, out_dir: str) -> str:
        import datetime
        base = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        stem = base
        i = 2
        while any(f.startswith(stem) for f in os.listdir(out_dir)):
            stem = f"{base}_{i}"
            i += 1
        return stem


def main() -> int:
    import sys
    app = QApplication(sys.argv)
    app.setApplicationName("TDOA Lab")
    win = MainWindow()
    win.show()
    return app.exec()
