"""PySide6 UI for the local sharpening debugger.

Run with::

    python -m sharpdebug

The UI is intentionally split into
  * 调试 (Debug)  : original / per-scale detail layers / final result,
                    fixed-axis pixel profile, clipping & hue maps.
  * 合成核查 (Charts): synthetic step edges and dense texture, sharpening
                    sweeps, export.

No display auto-stretch is applied to any measured image: the canvases clip
float data to [0,1] exactly as an 8-bit export would, while all numeric
read-outs come from the unclipped floats.
"""
from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass

import numpy as np
from PySide6.QtCore import QPointF, Qt, QTimer, Signal
from PySide6.QtGui import QAction, QColor, QImageReader, QKeySequence
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
    QSplitter,
    QTabWidget,
    QToolBar,
    QVBoxLayout,
    QWidget,
)

from . import analysis
from .core import (
    DEFAULT_SCALES,
    ScaleSpec,
    SharpenParams,
    clipping_stats,
    compute_sharpen,
    detail_to_display,
    luma,
    profile_line,
    synth_photo,
    synth_step_chart,
    synth_stripes,
)
from .widgets import (
    MUTED,
    CurvePlot,
    ImageCanvas,
    ProfilePlot,
    Series,
    compose_overlay,
)

# fixed display palette for the clipping / hue map (never image-dependent)
CLIP_COLOUR = (1.0, 0.16, 0.12)
HUE_COLOUR = (1.0, 0.78, 0.10)
DESAT_COLOUR = (0.15, 0.75, 0.95)
DETAIL_GAIN = 20.0


# ---------------------------------------------------------------------------
# small parameter widgets
# ---------------------------------------------------------------------------


class FloatSlider(QWidget):
    """Spin box + slider bound together, with an optional human hint."""

    valueChanged = Signal(float)

    def __init__(
        self,
        lo: float,
        hi: float,
        value: float,
        step: float = 0.01,
        decimals: int = 2,
        hint: str = "",
        parent=None,
    ):
        super().__init__(parent)
        self._scale = int(round(1.0 / step))
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(6)
        self.slider = QSlider(Qt.Horizontal)
        self.slider.setRange(int(round(lo * self._scale)), int(round(hi * self._scale)))
        self.slider.setValue(int(round(value * self._scale)))
        self.spin = QDoubleSpinBox()
        self.spin.setRange(lo, hi)
        self.spin.setSingleStep(step)
        self.spin.setDecimals(decimals)
        self.spin.setValue(value)
        self.spin.setFixedWidth(74)
        lay.addWidget(self.slider, 1)
        lay.addWidget(self.spin)
        self.slider.valueChanged.connect(self._from_slider)
        self.spin.valueChanged.connect(self._from_spin)
        if hint:
            self.setToolTip(hint)

    def _from_slider(self, v: int) -> None:
        val = v / self._scale
        if abs(self.spin.value() - val) > 1e-9:
            self.spin.blockSignals(True)
            self.spin.setValue(val)
            self.spin.blockSignals(False)
        self.valueChanged.emit(val)

    def _from_spin(self, v: float) -> None:
        sv = int(round(v * self._scale))
        if self.slider.value() != sv:
            self.slider.blockSignals(True)
            self.slider.setValue(sv)
            self.slider.blockSignals(False)
        self.valueChanged.emit(float(v))

    def value(self) -> float:
        return float(self.spin.value())

    def setValue(self, v: float) -> None:
        self.spin.setValue(v)


# ---------------------------------------------------------------------------
# main window
# ---------------------------------------------------------------------------


@dataclass
class Sample:
    name: str
    image: np.ndarray
    note: str = ""


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("锐化调试台 · 多尺度细节 / 白边抑制 / 像素剖面")
        self.resize(1480, 940)
        self.setStyleSheet(
            """
            QMainWindow { background: rgb(22,24,29); }
            QWidget { color: rgb(216,222,233); font-size: 12px; }
            QScrollArea, QScrollArea > QWidget > QWidget { background: rgb(22,24,29); }
            QGroupBox {
                border: 1px solid rgb(52,58,70); border-radius: 6px;
                margin-top: 14px; padding-top: 8px; font-weight: bold;
            }
            QGroupBox::title { subcontrol-origin: margin; left: 10px; padding: 0 4px; color: rgb(90,176,255); }
            QPushButton {
                background: rgb(44,50,62); border: 1px solid rgb(66,74,90);
                border-radius: 4px; padding: 5px 10px;
            }
            QPushButton:hover { background: rgb(56,64,80); }
            QPushButton:pressed { background: rgb(38,44,54); }
            QComboBox, QDoubleSpinBox {
                background: rgb(40,45,56); border: 1px solid rgb(66,74,90);
                border-radius: 4px; padding: 2px 4px;
            }
            QSlider::groove:horizontal { height: 4px; background: rgb(56,62,76); border-radius: 2px; }
            QSlider::handle:horizontal {
                width: 12px; margin: -5px 0; border-radius: 6px;
                background: rgb(90,176,255);
            }
            QTabWidget::pane { border: 1px solid rgb(52,58,70); }
            QTabBar::tab { padding: 6px 16px; background: rgb(31,35,43); }
            QTabBar::tab:selected { background: rgb(44,50,62); color: rgb(90,176,255); }
            QScrollArea { border: none; }
            QLabel { background: transparent; }
            QLabel#stats { font-family: Menlo, monospace; color: rgb(180,190,205); }
            """
        )

        # samples (generated locally; no external assets)
        self.samples: dict[str, Sample] = {
            "合成产品照 (白边/高光/纹理)": Sample(
                "合成产品照", synth_photo(), "含硬边轮廓、镜面高光、织物纹理与阶跃区"
            ),
            "合成阶跃边": Sample("合成阶跃边", synth_step_chart(), "三级对比度阶跃 + 密集线对"),
            "合成密集纹理": Sample("合成密集纹理", synth_stripes(), "啁啾条纹 + 微纹理 + 色调"),
        }
        self.base = self.samples[list(self.samples)[0]].image.copy()
        self.chart = synth_step_chart()
        self.stripes = synth_stripes()

        self.params = SharpenParams(scales=list(DEFAULT_SCALES))
        self.detail_view = "gated"
        self.overlays = {"clip": True, "hue": False, "desat": False}
        self.show_channels = False
        self.line_p0 = (self.base.shape[1] * 0.16, self.base.shape[0] * 0.50)
        self.line_p1 = (self.base.shape[1] * 0.80, self.base.shape[0] * 0.50)
        self.result_cache = None
        self.stats_cache: dict = {}
        self.sweeps: dict | None = None
        self.chart_result = None
        self.tex_result = None
        self.chart_dirty = True

        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.setInterval(45)
        self._timer.timeout.connect(self._recompute)

        self._build_toolbar()
        self._build_body()

        self._reset_line_buttons_enabled()

        self._recompute()

    # ------------------------------------------------------------------
    # layout
    # ------------------------------------------------------------------
    def _build_toolbar(self) -> None:
        tb = QToolBar("主工具栏")
        tb.setMovable(False)
        tb.setStyleSheet("QToolBar { background: rgb(28,32,40); spacing: 8px; padding: 4px; border-bottom: 1px solid rgb(52,58,70); }")
        self.addToolBar(tb)

        tb.addWidget(QLabel(" 样例 "))
        self.sample_combo = QComboBox()
        for name in self.samples:
            self.sample_combo.addItem(name)
        self.sample_combo.setMinimumWidth(250)
        self.sample_combo.currentTextChanged.connect(self._load_sample)
        tb.addWidget(self.sample_combo)

        open_act = QAction("载入本地图片…", self)
        open_act.setShortcut(QKeySequence.Open)
        open_act.triggered.connect(self._open_image)
        tb.addAction(open_act)

        tb.addSeparator()
        fit_act = QAction("适应窗口", self)
        fit_act.setShortcut("F")
        fit_act.triggered.connect(self._fit_all)
        tb.addAction(fit_act)

        reset_act = QAction("重置参数", self)
        reset_act.setShortcut("R")
        reset_act.triggered.connect(self._reset_params)
        tb.addAction(reset_act)

        tb.addSeparator()
        export_act = QAction("导出核查包…", self)
        export_act.triggered.connect(self._export)
        tb.addAction(export_act)

        spacer = QWidget()
        spacer.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        tb.addWidget(spacer)
        hint = QLabel("滚轮缩放 · 右键平移 · 拖动黄线取剖面 · 双击适应 ")
        hint.setStyleSheet(f"color: rgb({MUTED.red()},{MUTED.green()},{MUTED.blue()});")
        tb.addWidget(hint)

    def _build_body(self) -> None:
        split = QSplitter(Qt.Horizontal)
        split.addWidget(self._build_controls())
        split.addWidget(self._build_tabs())
        split.setStretchFactor(0, 0)
        split.setStretchFactor(1, 1)
        split.setSizes([400, 1080])
        self.setCentralWidget(split)

    def _build_controls(self) -> QWidget:
        panel = QWidget()
        panel.setMinimumWidth(380)
        panel.setMaximumWidth(460)
        outer = QVBoxLayout(panel)
        outer.setContentsMargins(8, 8, 8, 8)
        outer.setSpacing(8)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        inner = QWidget()
        lay = QVBoxLayout(inner)
        lay.setContentsMargins(2, 2, 2, 2)
        lay.setSpacing(10)

        # --- core params ---
        g1 = QGroupBox("锐化参数")
        f1 = QFormLayout(g1)
        f1.setLabelAlignment(Qt.AlignLeft)
        self.strength_w = FloatSlider(0.0, 3.0, self.params.strength, 0.01, hint="整体强度：乘在全部尺度细节之和上")
        self.strength_w.valueChanged.connect(self._schedule)
        f1.addRow("强度", self.strength_w)

        self.threshold_w = FloatSlider(
            0.0, 1.0, self.params.edge_threshold, 0.005,
            hint="强边缘抑制阈值：梯度超过该值的区域细节被门控压掉。越高 = 抑制越少",
        )
        self.threshold_w.valueChanged.connect(self._schedule)
        f1.addRow("边缘阈值", self.threshold_w)
        note1 = QLabel("阈值↑ → 更多强边细节通过（白边风险↑）")
        note1.setStyleSheet("color: rgb(140,150,166); font-size: 11px;")
        f1.addRow(note1)

        self.soft_w = FloatSlider(0.005, 0.30, self.params.edge_softness, 0.005,
                                  hint="门控过渡宽度，避免抑制边界出现硬阶梯")
        self.soft_w.valueChanged.connect(self._schedule)
        f1.addRow("过渡宽度", self.soft_w)

        self.bits_w = QCheckBox("模拟 8bit 导出 (量化)")
        self.bits_w.setChecked(self.params.quantize_bits == 8)
        self.bits_w.toggled.connect(self._schedule)
        f1.addRow(self.bits_w)
        self.chroma_combo = QComboBox()
        self.chroma_combo.addItem("逐通道 RGB (经典，边缘易偏色)", "rgb")
        self.chroma_combo.addItem("仅亮度 (保持色相)", "luma")
        self.chroma_combo.setToolTip(
            "逐通道锐化会独立放大 R/G/B，边缘容易产生色相漂移；\n"
            "仅亮度模式把同一个亮度细节加到三通道，从原理上不会旋转色相。"
        )
        self.chroma_combo.currentIndexChanged.connect(self._schedule)
        f1.addRow("锐化通道", self.chroma_combo)
        lay.addWidget(g1)

        # --- detail scales ---
        g2 = QGroupBox("细节层 (可编辑尺度)")
        v2 = QVBoxLayout(g2)
        head = QLabel("启用 / σ（尺度） / 权重")
        head.setStyleSheet("color: rgb(140,150,166); font-size: 11px;")
        v2.addWidget(head)
        self.scale_rows: list[dict] = []
        for i in range(3):
            row = QHBoxLayout()
            cb = QCheckBox(f"σ{i+1}")
            cb.setFixedWidth(42)
            cb.toggled.connect(self._schedule)
            sig = QDoubleSpinBox()
            sig.setRange(0.2, 12.0)
            sig.setSingleStep(0.1)
            sig.setDecimals(1)
            sig.setFixedWidth(64)
            sig.setSuffix(" px")
            sig.valueChanged.connect(self._schedule)
            wt = QDoubleSpinBox()
            wt.setRange(0.0, 2.0)
            wt.setSingleStep(0.05)
            wt.setDecimals(2)
            wt.setFixedWidth(64)
            wt.valueChanged.connect(self._schedule)
            contrib = QLabel("")
            contrib.setStyleSheet("color: rgb(140,150,166); font-size: 11px; font-family: Menlo, monospace;")
            row.addWidget(cb)
            row.addWidget(sig)
            row.addWidget(wt)
            row.addWidget(contrib, 1)
            v2.addLayout(row)
            self.scale_rows.append({"cb": cb, "sigma": sig, "weight": wt, "contrib": contrib})
        for i, spec in enumerate(DEFAULT_SCALES):
            self.scale_rows[i]["cb"].setChecked(spec.enabled)
            self.scale_rows[i]["sigma"].setValue(spec.sigma)
            self.scale_rows[i]["weight"].setValue(spec.weight)
        hint2 = QLabel("σ 小=纹理/细节，σ 大=轮廓过渡带（更易出白边）")
        hint2.setWordWrap(True)
        hint2.setStyleSheet("color: rgb(140,150,166); font-size: 11px;")
        v2.addWidget(hint2)
        lay.addWidget(g2)

        # --- display ---
        g3 = QGroupBox("显示")
        f3 = QFormLayout(g3)
        self.detail_view_combo = QComboBox()
        self.detail_view_combo.addItem("门控后细节 (参与合成)", "gated")
        self.detail_view_combo.addItem("未抑制细节 (对照)", "raw")
        self.detail_view_combo.addItem("边缘抑制门控", "gate")
        self.detail_view_combo.addItem("低通层 (被减去的背景)", "blur")
        self.detail_view_combo.currentIndexChanged.connect(self._on_view_combo)
        f3.addRow("尺度视图", self.detail_view_combo)
        self.gain_w = FloatSlider(1.0, 30.0, DETAIL_GAIN, 0.5, 1,
                                  hint="仅用于细节层显示的固定增益；±1/增益 即显示饱和。不改变图像，也绝不逐图自动缩放")
        self.gain_w.valueChanged.connect(self._refresh_detail_images)
        f3.addRow("细节显示增益", self.gain_w)
        lay.addWidget(g3)

        g4 = QGroupBox("结果叠加 (固定色标)")
        v4 = QVBoxLayout(g4)
        self.clip_cb = QCheckBox("截断像素 (红: 0 或 255)")
        self.hue_cb = QCheckBox("原始色相变化 >1° (黄)")
        self.desat_cb = QCheckBox("饱和度下降 >0.05 (青)")
        self.clip_cb.setChecked(True)
        for cb in (self.clip_cb, self.hue_cb, self.desat_cb):
            cb.toggled.connect(self._on_overlay_toggle)
            v4.addWidget(cb)
        lay.addWidget(g4)

        g5 = QGroupBox("数值")
        v5 = QVBoxLayout(g5)
        self.stats_label = QLabel("—")
        self.stats_label.setObjectName("stats")
        self.stats_label.setWordWrap(True)
        self.stats_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        v5.addWidget(self.stats_label)
        self.legend_label = QLabel(
            "所有数值来自未截断浮点结果；画面仅按 8bit 截断显示，不做自动拉伸。"
        )
        self.legend_label.setWordWrap(True)
        self.legend_label.setStyleSheet("color: rgb(140,150,166); font-size: 11px;")
        v5.addWidget(self.legend_label)
        lay.addWidget(g5)

        lay.addStretch(1)
        scroll.setWidget(inner)
        outer.addWidget(scroll, 1)

        btn_row = QHBoxLayout()
        reset_btn = QPushButton("恢复默认")
        reset_btn.clicked.connect(self._reset_params)
        exp_btn = QPushButton("导出…")
        exp_btn.clicked.connect(self._export)
        btn_row.addWidget(reset_btn)
        btn_row.addWidget(exp_btn)
        outer.addLayout(btn_row)
        return panel

    def _build_tabs(self) -> QWidget:
        self.tabs = QTabWidget()
        self.tabs.addTab(self._build_debug_tab(), "调试 · 细节层 / 剖面 / 截断")
        self.tabs.addTab(self._build_chart_tab(), "合成核查 · 阶跃边 / 密集纹理 / 扫参")
        self.tabs.currentChanged.connect(self._on_tab_changed)
        return self.tabs

    def _build_debug_tab(self) -> QWidget:
        page = QWidget()
        lay = QVBoxLayout(page)
        lay.setContentsMargins(6, 6, 6, 6)
        lay.setSpacing(6)

        grid = QGridLayout()
        grid.setSpacing(6)
        self.cv_original = ImageCanvas("原始图 (参考)", line_mode=True)
        self.cv_result = ImageCanvas("最终结果 (8bit 截断显示)", line_mode=True)
        self.cv_map = ImageCanvas("截断 / 色相变化图 (固定色标)")
        self.cv_details = []
        self.cv_original.lineChanged.connect(self._on_line_changed)
        self.cv_result.lineChanged.connect(self._on_line_changed)
        self.cv_original.hoverMoved.connect(self._on_hover)
        self.cv_result.hoverMoved.connect(self._on_hover)
        grid.addWidget(self.cv_original, 0, 0)
        grid.addWidget(self.cv_result, 0, 1)
        grid.addWidget(self.cv_map, 0, 2)
        for i in range(3):
            cv = ImageCanvas(f"细节层 σ{i+1}")
            self.cv_details.append(cv)
            grid.addWidget(cv, 1, i)
        for c in range(3):
            grid.setColumnStretch(c, 1)
        grid.setRowStretch(0, 3)
        grid.setRowStretch(1, 2)

        top = QWidget()
        top.setLayout(grid)
        bottom = self._build_profile_panel()
        splitter = QSplitter(Qt.Vertical)
        splitter.addWidget(top)
        splitter.addWidget(bottom)
        splitter.setSizes([560, 300])
        lay.addWidget(splitter, 1)
        return page

    def _build_profile_panel(self) -> QWidget:
        panel = QWidget()
        lay = QVBoxLayout(panel)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(4)
        bar = QHBoxLayout()
        bar.addWidget(QLabel("像素剖面"))
        bar.addWidget(QLabel("Y 轴:"))
        self.y_combo = QComboBox()
        for name in ("固定 −0.25 … 1.25", "固定 −0.60 … 1.60", "固定 −0.05 … 1.05"):
            self.y_combo.addItem(name)
        self.y_combo.setCurrentIndex(0)
        self.y_combo.currentTextChanged.connect(self._on_y_preset)
        bar.addWidget(self.y_combo)
        self.channel_cb = QCheckBox("显示 R/G/B 原值")
        self.channel_cb.toggled.connect(self._on_channel_toggle)
        bar.addWidget(self.channel_cb)
        self.line_label = QLabel("")
        self.line_label.setObjectName("stats")
        bar.addWidget(self.line_label, 1)
        lay.addLayout(bar)
        self.profile = ProfilePlot()
        lay.addWidget(self.profile, 1)
        return panel

    def _build_chart_tab(self) -> QWidget:
        page = QWidget()
        lay = QVBoxLayout(page)
        lay.setContentsMargins(6, 6, 6, 6)
        lay.setSpacing(6)

        topbar = QHBoxLayout()
        self.sweep_btn = QPushButton("运行参数扫参")
        self.sweep_btn.clicked.connect(self._run_sweeps)
        exp_btn = QPushButton("导出核查包…")
        exp_btn.clicked.connect(self._export)
        self.chart_note = QLabel("")
        self.chart_note.setObjectName("stats")
        topbar.addWidget(self.sweep_btn)
        topbar.addWidget(exp_btn)
        topbar.addWidget(self.chart_note, 1)
        lay.addLayout(topbar)

        grid = QGridLayout()
        grid.setSpacing(6)
        self.cv_chart_in = ImageCanvas("阶跃图 · 原始")
        self.cv_chart_out = ImageCanvas("阶跃图 · 锐化后", line_mode=True)
        self.cv_tex_in = ImageCanvas("密集纹理 · 原始")
        self.cv_tex_out = ImageCanvas("密集纹理 · 锐化后")
        self.cv_chart_out.lineChanged.connect(self._on_chart_line)
        grid.addWidget(self.cv_chart_in, 0, 0)
        grid.addWidget(self.cv_chart_out, 0, 1)
        grid.addWidget(self.cv_tex_in, 1, 0)
        grid.addWidget(self.cv_tex_out, 1, 1)
        for c in range(2):
            grid.setColumnStretch(c, 1)
            grid.setRowStretch(c, 1)
        lay.addLayout(grid, 3)

        plots = QGridLayout()
        plots.setSpacing(6)
        self.plot_step = ProfilePlot()
        self.plot_step.title = "阶跃边剖面 (合成图)"
        self.plot_strength = CurvePlot("强度扫参")
        self.plot_threshold = CurvePlot("阈值扫参")
        plots.addWidget(self.plot_step, 0, 0)
        plots.addWidget(self.plot_strength, 0, 1)
        plots.addWidget(self.plot_threshold, 0, 2)
        for c in range(3):
            plots.setColumnStretch(c, 1)
        lay.addLayout(plots, 2)
        return page

    # ------------------------------------------------------------------
    # parameter plumbing
    # ------------------------------------------------------------------
    def _schedule(self, *_args) -> None:
        self._timer.start()

    def _collect_params(self) -> SharpenParams:
        scales = []
        defaults = list(DEFAULT_SCALES)
        for i, row in enumerate(self.scale_rows):
            scales.append(
                ScaleSpec(
                    sigma=float(row["sigma"].value()),
                    weight=float(row["weight"].value()),
                    gate_sigma=defaults[i].gate_sigma,
                    enabled=bool(row["cb"].isChecked()),
                )
            )
        return SharpenParams(
            strength=self.strength_w.value(),
            edge_threshold=self.threshold_w.value(),
            edge_softness=self.soft_w.value(),
            scales=scales,
            quantize_bits=8 if self.bits_w.isChecked() else 0,
            chroma=self.chroma_combo.currentData() if hasattr(self, "chroma_combo") else "rgb",
        )

    def _reset_params(self) -> None:
        for w, v in (
            (self.strength_w, 1.0),
            (self.threshold_w, 0.15),
            (self.soft_w, 0.06),
        ):
            w.setValue(v)
        self.bits_w.setChecked(False)
        self.chroma_combo.setCurrentIndex(0)
        for i, spec in enumerate(DEFAULT_SCALES):
            rows = getattr(self, "scale_rows", [])
            if i < len(rows):
                rows[i]["cb"].setChecked(spec.enabled)
                rows[i]["sigma"].setValue(spec.sigma)
                rows[i]["weight"].setValue(spec.weight)
        self.detail_view_combo.setCurrentIndex(0)
        if hasattr(self, "gain_w"):
            self.gain_w.setValue(DETAIL_GAIN)
        self._schedule()

    def _on_view_combo(self, _idx: int) -> None:
        self.detail_view = self.detail_view_combo.currentData()
        if self.result_cache is not None:
            self._refresh_detail_images()

    def _on_overlay_toggle(self, *_args) -> None:
        self.overlays["clip"] = self.clip_cb.isChecked()
        self.overlays["hue"] = self.hue_cb.isChecked()
        self.overlays["desat"] = self.desat_cb.isChecked()
        if self.result_cache is not None:
            self._refresh_result_and_map(self.result_cache, self.stats_cache)

    def _on_channel_toggle(self, _v: bool) -> None:
        self.show_channels = self.channel_cb.isChecked()
        if self.result_cache is not None:
            self._refresh_profile(self.result_cache)

    def _on_y_preset(self, name: str) -> None:
        self.profile.set_y_preset(name)
        self.plot_step.set_y_preset(name)

    def _on_line_changed(self, p0: QPointF, p1: QPointF) -> None:
        self.line_p0 = (p0.x(), p0.y())
        self.line_p1 = (p1.x(), p1.y())
        # mirror the line to the other canvas
        for cv in (self.cv_original, self.cv_result):
            cv.set_line(self.line_p0, self.line_p1)
        if self.result_cache is not None:
            self._refresh_profile(self.result_cache)

    def _on_chart_line(self, p0: QPointF, p1: QPointF) -> None:
        self.chart_p0 = (p0.x(), p0.y())
        self.chart_p1 = (p1.x(), p1.y())
        self.cv_chart_in.set_line(self.chart_p0, self.chart_p1)
        self.cv_chart_out.set_line(self.chart_p0, self.chart_p1)
        if self.chart_result is not None:
            self._refresh_chart_profile()

    def _on_hover(self, x: float, y: float) -> None:
        # canvases already show live coordinates in their own HUD
        return

    def _on_tab_changed(self, idx: int) -> None:
        if idx == 1 and self.chart_dirty:
            self._ensure_chart()

    def _fit_all(self) -> None:
        for cv in self._all_canvases():
            cv.fit()

    def _all_canvases(self) -> list[ImageCanvas]:
        out = [self.cv_original, self.cv_result, self.cv_map, *self.cv_details]
        out += [self.cv_chart_in, self.cv_chart_out, self.cv_tex_in, self.cv_tex_out]
        return out

    def _reset_line_buttons_enabled(self) -> None:
        self.cv_original.set_line(self.line_p0, self.line_p1)
        self.cv_result.set_line(self.line_p0, self.line_p1)
        self.chart_p0 = (self.chart.shape[1] * 0.35, self.chart.shape[0] * 0.55)
        self.chart_p1 = (self.chart.shape[1] * 0.65, self.chart.shape[0] * 0.55)
        self.cv_chart_in.set_line(self.chart_p0, self.chart_p1)
        self.cv_chart_out.set_line(self.chart_p0, self.chart_p1)

    # ------------------------------------------------------------------
    # sample / file loading
    # ------------------------------------------------------------------
    def _load_sample(self, name: str) -> None:
        sample = self.samples.get(name)
        if sample is None:
            return
        self.base = sample.image.copy()
        self._reset_line_for_image()
        self.chart_dirty = True
        self._recompute()

    def _reset_line_for_image(self) -> None:
        h, w = self.base.shape[:2]
        self.line_p0 = (w * 0.16, h * 0.50)
        self.line_p1 = (w * 0.80, h * 0.50)
        self.cv_original.set_line(self.line_p0, self.line_p1)
        self.cv_result.set_line(self.line_p0, self.line_p1)

    def _open_image(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "载入图片", "", "图片 (*.png *.jpg *.jpeg *.bmp *.tif *.tiff *.webp)"
        )
        if not path:
            return
        reader = QImageReader(path)
        reader.setAutoTransform(True)
        img = reader.read()
        if img.isNull():
            QMessageBox.warning(self, "载入失败", f"无法读取:\n{path}\n{reader.errorString()}")
            return
        if img.format() != img.Format.Format_RGB888:
            img = img.convertToFormat(img.Format.Format_RGB888)
        w, h = img.width(), img.height()
        ptr = img.constBits()
        arr = np.frombuffer(ptr, dtype=np.uint8, count=img.sizeInBytes())
        arr = arr.reshape(h, img.bytesPerLine())[:, : w * 3].reshape(h, w, 3)
        arr = np.ascontiguousarray(arr).astype(np.float64) / 255.0
        max_dim = 1600
        if max(w, h) > max_dim:
            step = int(np.ceil(max(w, h) / max_dim))
            arr = arr[::step, ::step]
        self.base = np.clip(arr, 0, 1)
        self.sample_combo.blockSignals(True)
        self.sample_combo.setCurrentIndex(-1)
        self.sample_combo.blockSignals(False)
        self._reset_line_for_image()
        self.chart_dirty = True
        self._recompute()

    # ------------------------------------------------------------------
    # computation
    # ------------------------------------------------------------------
    def _recompute(self) -> None:
        self.params = self._collect_params()
        self.result_cache = compute_sharpen(self.base, self.params)
        self.stats_cache = clipping_stats(self.result_cache, None)
        # contribution rows must be ready before the detail canvases read them
        self._refresh_stats_label()
        self.cv_original.set_image(self.result_cache.base, "原始输入 · 未做任何拉伸")
        self._refresh_result_and_map(self.result_cache, self.stats_cache)
        self._refresh_detail_images()
        self._refresh_profile(self.result_cache)
        self._refresh_contrib_labels()
        if self.tabs.currentIndex() == 1:
            self._ensure_chart()
        else:
            self.chart_dirty = True

    def _refresh_result_and_map(self, res, stats) -> None:
        overlays = []
        if self.overlays["clip"] and stats.get("clipped_any", 0):
            overlays.append((stats["clipped_mask"], CLIP_COLOUR, 0.75))
        if self.overlays["hue"] and stats.get("hue_shift_px", 0):
            overlays.append((stats["hue_shift_mask"], HUE_COLOUR, 0.65))
        if self.overlays["desat"] and stats.get("desat_px", 0):
            overlays.append((stats["desat_mask"], DESAT_COLOUR, 0.65))
        disp = compose_overlay(res.result, overlays)
        self.cv_result.set_image(
            disp,
            info=(
                f"截断 {stats['clipped_any']:,} px ({stats['clipped_ratio']*100:.2f}%) · "
                f"色相>1° {stats['hue_shift_px']:,} px · "
                f"过冲 +{max(stats['max_overshoot'],0):.4f} / 欠冲 −{max(stats['max_undershoot'],0):.4f}"
            ),
            legend="叠加: 红=截断 黄=色相变化 青=降饱和 (固定色标)",
        )
        # dedicated map: fixed colours, no base image (so counts are visible)
        m = np.zeros((*stats["clipped_mask"].shape, 3), dtype=np.float64)
        m[:] = (0.10, 0.11, 0.13)
        m = np.where(stats["clipped_mask"][..., None], np.array(CLIP_COLOUR), m)
        if stats.get("hue_shift_px", 0):
            m = np.where(stats["hue_shift_mask"][..., None], np.array(HUE_COLOUR), m)
        if stats.get("desat_px", 0):
            m = np.where(stats["desat_mask"][..., None], np.array(DESAT_COLOUR), m)
        self.cv_map.set_image(
            m,
            info=(
                f"红=截断({stats['clipped_any']:,})  黄=色相漂移({stats['hue_shift_px']:,})  "
                f"青=降饱和({stats['desat_px']:,})"
            ),
            legend=f"色相最大漂移 {stats['hue_shift_deg_max']:.2f}° · 平均 {stats['hue_shift_deg_mean']:.2f}°",
        )

    def _refresh_detail_images(self) -> None:
        res = self.result_cache
        if res is None:
            return
        gain = self.gain_w.value() if hasattr(self, "gain_w") else DETAIL_GAIN
        for i, cv in enumerate(self.cv_details):
            if i >= len(res.details):
                continue
            spec = self.params.scales[i]
            if self.detail_view == "gate":
                g = np.repeat(res.gates[i][..., None], 3, axis=-1)
                disp = np.clip(g, 0, 1)
                legend = "白=细节可通过，黑=被强边缘抑制"
            elif self.detail_view == "blur":
                disp = res.blurs[i]
                legend = "低通背景 (0..1 直接显示)"
            elif self.detail_view == "raw":
                disp = detail_to_display(res.raw_details[i], gain)
                legend = f"未门控细节 · 固定增益 ×{gain:g}（红正/蓝负）"
            else:
                disp = detail_to_display(res.details[i], gain)
                legend = f"门控后细节 · 固定增益 ×{gain:g}（红正/蓝负，饱和于 ±{1.0/max(gain,1e-6):.3f}）"
            kept = 0.0
            rms = float(np.sqrt(np.mean(luma(res.details[i]) ** 2)))
            if i < len(self.stats_cache.get("scale_rows", [])):
                kept = self.stats_cache["scale_rows"][i]["kept_ratio"]
            cv.set_title(f"细节层 σ={spec.sigma:g}px  w={spec.weight:.2f}")
            cv.set_image(
                disp,
                info=f"σ={spec.sigma:g}  权重={spec.weight:.2f}  "
                     f"{'启用' if spec.enabled else '停用'}  保留 {kept*100:.0f}%  "
                     f"细节RMS {rms*1000:.2f}‰",
                legend=legend,
            )

    def _refresh_profile(self, res) -> None:
        # Profile the *unclipped* float result: clipped output would cap
        # overshoot at 1.0 and hide exactly the white fringe we are measuring.
        x, y, vals = profile_line(res.result_unclipped, self.line_p0, self.line_p1, 480)
        bx, by, bvals = profile_line(res.base, self.line_p0, self.line_p1, 480)
        base_l = bvals @ np.array([0.2126, 0.7152, 0.0722])
        dist = np.concatenate([[0.0], np.cumsum(np.hypot(np.diff(x), np.diff(y)))])
        self.profile.set_data(dist, base_l, vals, self.show_channels, "像素剖面 · 结果 vs 原始")
        self.profile.set_notes(self._global_notes(vals))
        luma = vals @ np.array([0.2126, 0.7152, 0.0722])
        self.line_label.setText(
            f"({self.line_p0[0]:.0f},{self.line_p0[1]:.0f}) → ({self.line_p1[0]:.0f},{self.line_p1[1]:.0f})  "
            f"长 {dist[-1]:.0f}px · 剖面过冲 +{max(0.0, luma.max()-1):.4f} · "
            f"欠冲 −{max(0.0, -luma.min()):.4f} · 范围 {luma.min():.4f}…{luma.max():.4f}"
        )

    def _global_notes(self, line_vals: np.ndarray) -> list[str]:
        """Full-image numbers, so a profile through a quiet area cannot read 0."""
        res = self.result_cache
        if res is None:
            return []
        u = res.result_unclipped
        gmax = float(u.max())
        gmin = float(u.min())
        l = u @ np.array([0.2126, 0.7152, 0.0722])
        iy, ix = np.unravel_index(int(np.argmax(l)), l.shape)
        return [
            f"全图 过冲 max +{max(0.0, gmax - 1):.4f}  欠冲 max −{max(0.0, -gmin):.4f} "
            f"(未截断浮点，约 {(gmax-1)*255:+.1f}/255 码值)",
            f"全图最亮像素 ({ix},{iy}) 亮度 {l[iy, ix]:.4f}；剖面仅代表这条线",
        ]

    def _refresh_stats_label(self) -> None:
        st = self.stats_cache
        rows = analysis.per_scale_contribution_from_result(
            self.result_cache, self.params.scales
        )
        self.stats_cache["scale_rows"] = rows
        lines = [
            f"截断 高光 {st['clipped_high']:>6,}  阴影 {st['clipped_low']:>6,}  "
            f"合计 {st['clipped_any']:>6,} ({st['clipped_ratio']*100:.2f}%)",
            f"色相漂移 >1°  {st['hue_shift_px']:>6,} px  最大 {st['hue_shift_deg_max']:.2f}°  "
            f"均值 {st['hue_shift_deg_mean']:.2f}°",
            f"降饱和 {st['desat_px']:>6,} px",
            f"过冲 max +{max(st['max_overshoot'],0):.4f}   欠冲 max −{max(st['max_undershoot'],0):.4f}  (未截断浮点)",
        ]
        self.stats_label.setText("\n".join(lines))

    def _refresh_contrib_labels(self) -> None:
        rows = self.stats_cache.get("scale_rows", [])
        for i, row in enumerate(self.scale_rows):
            if i < len(rows):
                r = rows[i]
                row["contrib"].setText(
                    f"原{r['raw_rms']*1000:.2f} / 后{r['gated_rms']*1000:.2f} ‰  保留{r['kept_ratio']*100:.0f}%"
                )
            else:
                row["contrib"].setText("")

    # ------------------------------------------------------------------
    # chart tab
    # ------------------------------------------------------------------
    def _ensure_chart(self) -> None:
        self.chart_dirty = False
        res = compute_sharpen(self.chart, self.params)
        self.chart_result = res
        self.cv_chart_in.set_image(self.chart, "合成阶跃图 · 原始")
        self.cv_chart_out.set_image(
            res.result,
            info=(
                f"过冲 +{max(0, res.result_unclipped.max()-1):.4f}  "
                f"欠冲 −{max(0, -res.result_unclipped.min()):.4f} "
                f"(未截断浮点；显示为 8bit 截断)"
            ),
            legend="含三级对比度阶跃与密集线对；黄线可拖动",
        )
        t_res = compute_sharpen(self.stripes, self.params)
        self.tex_result = t_res
        self.cv_tex_in.set_image(self.stripes, "密集纹理 · 原始")
        m = analysis.texture_metrics(t_res.result)
        base_m = analysis.texture_metrics(self.stripes)
        self.cv_tex_out.set_image(
            t_res.result,
            info=f"高频 RMS {m['hf_rms']*1000:.2f}‰ (原 {base_m['hf_rms']*1000:.2f}‰, "
                 f"增益 {m['hf_rms']/max(base_m['hf_rms'],1e-9):.2f}×)",
            legend="固定 1:1 显示，暗部/亮部不自动拉伸",
        )
        self.cv_chart_in.set_line(self.chart_p0, self.chart_p1)
        self.cv_chart_out.set_line(self.chart_p0, self.chart_p1)
        self._refresh_chart_profile()
        self._update_sweep_plots()

    def _refresh_chart_profile(self) -> None:
        res = self.chart_result
        if res is None:
            return
        # unclipped floats so overshoot is not capped at 1.0
        x, y, vals = profile_line(res.result_unclipped, self.chart_p0, self.chart_p1, 480)
        _, _, bvals = profile_line(self.chart, self.chart_p0, self.chart_p1, 480)
        base_l = bvals @ np.array([0.2126, 0.7152, 0.0722])
        dist = np.concatenate([[0.0], np.cumsum(np.hypot(np.diff(x), np.diff(y)))])
        self.plot_step.set_data(dist, base_l, vals, False, "阶跃边 / 线对剖面 · 固定 Y")
        luma = vals @ np.array([0.2126, 0.7152, 0.0722])
        m = analysis.step_edge_metrics(res.result_unclipped, self.chart)
        self.plot_step.set_notes(
            [
                f"全图阶跃带 过冲 max +{max(e.overshoot for e in m):.4f}  "
                f"欠冲 max −{max(e.undershoot for e in m):.4f} (未截断浮点)",
                "剖面仅代表当前黄线；阶跃测量取三条带的整行平均",
            ]
        )
        self.line_label.setText(
            f"阶跃剖面 长 {dist[-1]:.0f}px · 剖面过冲 +{max(0.0, luma.max()-1):.4f} · "
            f"欠冲 −{max(0.0, -luma.min()):.4f}"
        )

    def _run_sweeps(self) -> None:
        self.sweep_btn.setEnabled(False)
        QApplication.setOverrideCursor(Qt.WaitCursor)
        try:
            self.sweeps = {
                "strength": analysis.sweep_strength(self.chart, self.params),
                "threshold": analysis.sweep_threshold(self.chart, self.params),
            }
        finally:
            QApplication.restoreOverrideCursor()
            self.sweep_btn.setEnabled(True)
        self._update_sweep_plots(force=True)

    def _update_sweep_plots(self, force: bool = False) -> None:
        if not self.sweeps:
            self.plot_strength.set_series([], "强度", "过冲 / 纹理增益",
                                          title="强度扫参 (点击『运行参数扫参』)")
            self.plot_threshold.set_series([], "边缘阈值", "过冲 / 纹理增益",
                                           title="阈值扫参 (点击『运行参数扫参』)")
            return
        sw = self.sweeps["strength"]["rows"]
        xs = np.array([r["strength"] for r in sw])
        self.plot_strength.set_series(
            [
                Series(xs, np.array([r["max_overshoot"] for r in sw]), QColor(255, 92, 92), "最大过冲 (0..1)"),
                Series(xs, np.array([r["max_undershoot"] for r in sw]), QColor(86, 156, 255), "最大欠冲 (0..1)"),
                Series(xs, np.array([r["mean_ringing_pct"] / 100.0 for r in sw]), QColor(255, 190, 90), "振铃 %÷100", dashed=True),
                Series(xs, np.array([r["texture_gain"] for r in sw]), QColor(120, 220, 150), "纹理增益 ×", axis=1),
            ],
            x_label="强度",
            y_label="左轴: 绝对过冲/欠冲 (0..1)",
            y2_label="纹理增益 (相对原始)",
            title="强度扫参",
        )
        th = self.sweeps["threshold"]["rows"]
        xs2 = np.array([r["threshold"] for r in th])
        self.plot_threshold.set_series(
            [
                Series(xs2, np.array([r["max_overshoot"] for r in th]), QColor(255, 92, 92), "最大过冲 (0..1)"),
                Series(xs2, np.array([r["mean_ringing_pct"] / 100.0 for r in th]), QColor(255, 190, 90), "振铃 %÷100", dashed=True),
                Series(xs2, np.array([r["texture_gain"] for r in th]), QColor(120, 220, 150), "纹理增益 ×", axis=1),
            ],
            x_label="边缘阈值 (越高抑制越少)",
            y_label="左轴: 绝对过冲/欠冲 (0..1)",
            y2_label="纹理增益 (相对原始)",
            title="阈值扫参",
        )
        if self.sweeps:
            rows = sw
            if rows:
                budget = 0.01  # ~2.5/255: below one 8-bit code for most tones
                ok = [r for r in rows if r["max_overshoot"] <= budget]
                best = max(ok, key=lambda r: r["texture_gain"]) if ok else min(
                    rows, key=lambda r: r["max_overshoot"]
                )
                gain_now = self._texture_gain_now(rows)
                self.chart_note.setText(
                    f"扫参完成: 过冲 ≤{budget:.3f} 前提下, 建议强度 {best['strength']:.2f} "
                    f"(过冲 +{best['max_overshoot']:.4f}, 纹理增益 {best['texture_gain']:.2f}×) · "
                    f"当前参数实测过冲 +{self._current_chart_overshoot():.4f}"
                    + (f", 纹理增益 {gain_now:.2f}×" if gain_now is not None else "")
                )

    def _texture_gain_now(self, rows: list[dict]) -> float | None:
        base = self.sweeps["strength"]["rows"][0] if self.sweeps else None
        if not base:
            return None
        # nearest sampled strength to the current slider value
        cur = self.strength_w.value()
        r = min(rows, key=lambda x: abs(x["strength"] - cur))
        return r["texture_gain"]

    def _current_chart_overshoot(self) -> float:
        res = self.chart_result
        if res is None:
            return 0.0
        m = analysis.step_edge_metrics(res.result_unclipped, self.chart)
        return max((e.overshoot for e in m), default=0.0)

    # ------------------------------------------------------------------
    # export
    # ------------------------------------------------------------------
    def _export(self) -> None:
        default = os.path.abspath("sharpdebug_export")
        out = QFileDialog.getExistingDirectory(self, "选择导出目录", default)
        if not out:
            return
        QApplication.setOverrideCursor(Qt.WaitCursor)
        try:
            x, y, vals = profile_line(self.result_cache.result_unclipped, self.line_p0, self.line_p1, 480)
            _, _, bvals = profile_line(self.result_cache.base, self.line_p0, self.line_p1, 480)
            base_l = bvals @ np.array([0.2126, 0.7152, 0.0722])
            manifest = analysis.export_bundle(
                out,
                self.base,
                self.result_cache.result,
                self.params,
                profile=(np.arange(len(base_l)), base_l, vals),
                chart=self.chart,
                chart_result=(
                    self.chart_result.result if self.chart_result is not None else None
                ),
            )
            # also export sweep tables if they exist
            if self.sweeps:
                import csv
                import json

                for key, data in self.sweeps.items():
                    path = os.path.join(out, f"sweep_{key}.csv")
                    with open(path, "w", newline="", encoding="utf-8") as fh:
                        wr = csv.DictWriter(fh, fieldnames=list(data["rows"][0].keys()))
                        wr.writeheader()
                        wr.writerows(data["rows"])
                    manifest.setdefault("files", {})[f"sweep_{key}.csv"] = f"sweep_{key}.csv"
                for key, data in self.sweeps.items():
                    manifest[f"sweep_{key}"] = data["rows"]
                with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as fh:
                    json.dump(manifest, fh, ensure_ascii=False, indent=2)
        except OSError as exc:
            QApplication.restoreOverrideCursor()
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        QApplication.restoreOverrideCursor()
        QMessageBox.information(
            self, "导出完成",
            f"已写入 {out}\n\n"
            "result.png / original.png / detail_sigma_*.png\n"
            "overlay_clipping.png / overlay_hue_shift.png\n"
            "profile.csv / step_edges.csv / sweep_*.csv\n"
            "manifest.json (全部数值与参数)",
        )


def _demo_screenshot(path: str) -> int:
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication(sys.argv)
    win = MainWindow()
    win.resize(1480, 940)
    win.show()
    app.processEvents()
    win.tabs.setCurrentIndex(1)
    win._run_sweeps()
    app.processEvents()
    win.grab().save(path)
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(description="小物件照片多尺度锐化调试台")
    parser.add_argument("--screenshot", metavar="PATH", help="离屏渲染一张界面截图后退出")
    parser.add_argument("--sample", choices=["photo", "step", "texture"], default="photo")
    args = parser.parse_args(argv)

    if args.screenshot:
        return _demo_screenshot(args.screenshot)

    app = QApplication(sys.argv)
    win = MainWindow()
    if args.sample == "step":
        win.sample_combo.setCurrentText("合成阶跃边")
    elif args.sample == "texture":
        win.sample_combo.setCurrentText("合成密集纹理")
    win.show()
    return app.exec()
