"""主窗口：参数控制 + 波形/音高/音分三图 + 帧详情与候选依据。"""

from __future__ import annotations

import math

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QComboBox, QDoubleSpinBox, QFileDialog, QFormLayout, QGroupBox,
    QHBoxLayout, QLabel, QMainWindow, QMessageBox, QPlainTextEdit,
    QPushButton, QSpinBox, QSplitter, QTableWidget, QTableWidgetItem,
    QVBoxLayout, QWidget,
)

from . import notes
from .analysis import AnalysisParams, AnalysisResult, analyze
from .audio import Player
from .exporter import export_segment_csv
from .plots import CentsPlot, PitchPlot, WaveformPlot
from .signals import Sample, all_samples
from .state import ViewState
from .wavio import load_wav


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("单音音高测量 · Pitch Lab")
        self.resize(1280, 860)

        self.state = ViewState(1.0)
        self.player = Player(self)
        self.samples: list[Sample] = all_samples()
        self.audio: np.ndarray | None = None
        self.fs = 0
        self.result: AnalysisResult | None = None
        self.references = []
        self.a4 = 440.0
        self._guard = False

        self._build_ui()
        self._wire()
        self._load_sample(0)

    # ---------------- UI 搭建 ----------------
    def _build_ui(self) -> None:
        central = QWidget()
        root = QVBoxLayout(central)

        # 顶部：数据源
        src_box = QGroupBox("数据源")
        src_lay = QHBoxLayout(src_box)
        self.sample_combo = QComboBox()
        for s in self.samples:
            self.sample_combo.addItem(s.name)
        self.btn_open = QPushButton("打开 WAV…")
        self.lbl_file = QLabel("内置样例")
        src_lay.addWidget(QLabel("内置:"))
        src_lay.addWidget(self.sample_combo, 2)
        src_lay.addWidget(self.btn_open)
        src_lay.addWidget(self.lbl_file, 3)
        root.addWidget(src_box)

        # 参数行
        par_box = QGroupBox("分析与显示参数")
        par_lay = QHBoxLayout(par_box)

        form1 = QFormLayout()
        self.sp_fmin = QDoubleSpinBox()
        self.sp_fmin.setRange(20.0, 4000.0); self.sp_fmin.setValue(65.0)
        self.sp_fmax = QDoubleSpinBox()
        self.sp_fmax.setRange(30.0, 8000.0); self.sp_fmax.setValue(1400.0)
        self.sp_frame = QDoubleSpinBox()
        self.sp_frame.setRange(15.0, 200.0); self.sp_frame.setValue(46.0); self.sp_frame.setSuffix(" ms")
        self.sp_hop = QDoubleSpinBox()
        self.sp_hop.setRange(2.0, 100.0); self.sp_hop.setValue(10.0); self.sp_hop.setSuffix(" ms")
        form1.addRow("音域下限 Hz", self.sp_fmin)
        form1.addRow("音域上限 Hz", self.sp_fmax)
        form1.addRow("帧长", self.sp_frame)
        form1.addRow("帧移", self.sp_hop)

        form2 = QFormLayout()
        self.sp_rms = QDoubleSpinBox()
        self.sp_rms.setRange(0.0005, 0.5); self.sp_rms.setDecimals(4); self.sp_rms.setSingleStep(0.002); self.sp_rms.setValue(0.012)
        self.sp_noise = QDoubleSpinBox()
        self.sp_noise.setRange(0.05, 0.95); self.sp_noise.setSingleStep(0.02); self.sp_noise.setValue(0.32)
        self.sp_score = QDoubleSpinBox()
        self.sp_score.setRange(0.1, 0.95); self.sp_score.setSingleStep(0.02); self.sp_score.setValue(0.45)
        self.sp_oct = QDoubleSpinBox()
        self.sp_oct.setRange(0.01, 0.4); self.sp_oct.setSingleStep(0.01); self.sp_oct.setValue(0.08)
        form2.addRow("音量门槛 RMS", self.sp_rms)
        form2.addRow("噪声门槛(平坦度)", self.sp_noise)
        form2.addRow("可信分门槛", self.sp_score)
        form2.addRow("八度存疑余量", self.sp_oct)

        form3 = QFormLayout()
        self.sp_onset = QSpinBox()
        self.sp_onset.setRange(5, 300); self.sp_onset.setValue(45); self.sp_onset.setSuffix(" ms")
        self.sp_a4 = QDoubleSpinBox()
        self.sp_a4.setRange(400.0, 480.0); self.sp_a4.setDecimals(2); self.sp_a4.setSingleStep(0.5); self.sp_a4.setValue(440.0)
        self.cmb_accidental = QComboBox()
        self.cmb_accidental.addItems(["升号 (#)", "降号 (b)"])
        form3.addRow("起音保护", self.sp_onset)
        form3.addRow("基准音高 A4 Hz", self.sp_a4)
        form3.addRow("音名显示", self.cmb_accidental)

        for f in (form1, form2, form3):
            par_lay.addLayout(f)
        par_lay.addStretch(1)
        root.addWidget(par_box)

        # 视图/播放/导出
        ctrl_lay = QHBoxLayout()
        self.btn_zoom_in = QPushButton("放大")
        self.btn_zoom_out = QPushButton("缩小")
        self.btn_reset = QPushButton("重置视图")
        self.btn_play = QPushButton("试听全部")
        self.btn_play_sel = QPushButton("试听圈选段")
        self.btn_stop = QPushButton("停止")
        self.btn_export = QPushButton("导出圈选段 CSV…")
        self.lbl_sel = QLabel("未圈选")
        for b in (self.btn_zoom_in, self.btn_zoom_out, self.btn_reset,
                  self.btn_play, self.btn_play_sel, self.btn_stop, self.btn_export):
            ctrl_lay.addWidget(b)
        ctrl_lay.addWidget(self.lbl_sel, 2)
        root.addLayout(ctrl_lay)

        # 三图
        self.wave = WaveformPlot(self.state)
        self.pitch = PitchPlot(self.state)
        self.cents = CentsPlot(self.state)
        splitter = QSplitter(Qt.Orientation.Vertical)
        splitter.addWidget(self.wave)
        splitter.addWidget(self.pitch)
        splitter.addWidget(self.cents)
        splitter.setSizes([160, 320, 200])

        # 右侧详情
        right = QWidget()
        right_lay = QVBoxLayout(right)
        right_lay.addWidget(QLabel("选中帧：主判断与八度备选依据"))
        self.table = QTableWidget(0, 7)
        self.table.setHorizontalHeaderLabels(
            ["频率 Hz", "音名", "自相关峰", "谐波评分", "基频谱支持", "综合分", "来源"])
        header = self.table.horizontalHeader()
        header.setStretchLastSection(True)
        for col in range(6):
            header.setSectionResizeMode(col, header.ResizeMode.ResizeToContents)
        right_lay.addWidget(self.table, 2)

        self.detail = QPlainTextEdit()
        self.detail.setReadOnly(True)
        right_lay.addWidget(self.detail, 1)

        self.ref_text = QPlainTextEdit()
        self.ref_text.setReadOnly(True)
        self.ref_text.setMaximumHeight(150)
        right_lay.addWidget(QLabel("分段参考（内置样例可核对）"))
        right_lay.addWidget(self.ref_text)

        hsplitter = QSplitter(Qt.Orientation.Horizontal)
        hsplitter.addWidget(splitter)
        hsplitter.addWidget(right)
        hsplitter.setSizes([800, 480])
        root.addWidget(hsplitter, 1)
        self.setCentralWidget(central)
        self.statusBar().showMessage("就绪")

    def _wire(self) -> None:
        self.sample_combo.currentIndexChanged.connect(self._load_sample)
        self.btn_open.clicked.connect(self._open_wav)

        for sp in (self.sp_fmin, self.sp_fmax, self.sp_frame, self.sp_hop,
                   self.sp_rms, self.sp_noise, self.sp_score, self.sp_oct):
            sp.valueChanged.connect(self._reanalyze)
        self.sp_onset.valueChanged.connect(self._reanalyze)

        self.sp_a4.valueChanged.connect(self._a4_changed)
        self.cmb_accidental.currentIndexChanged.connect(self._naming_changed)

        self.btn_zoom_in.clicked.connect(lambda: self.state.zoom(1 / 1.4))
        self.btn_zoom_out.clicked.connect(lambda: self.state.zoom(1.4))
        self.btn_reset.clicked.connect(lambda: self.state.set_view(0.0, self.state.duration))
        self.btn_play.clicked.connect(lambda: self.player.play_range())
        self.btn_play_sel.clicked.connect(self._play_selection)
        self.btn_stop.clicked.connect(self.player.stop)
        self.btn_export.clicked.connect(self._export)

        for plot in (self.wave, self.pitch, self.cents):
            plot.viewZoomed.connect(self._on_view_zoom)
            plot.viewPanned.connect(self.state.pan_ratio)
            plot.viewReset.connect(
                lambda: self.state.set_view(0.0, self.state.duration))
            plot.cursorPicked.connect(self._show_frame)
            plot.selectionPicked.connect(self.state.set_selection)

        self.state.selectionChanged.connect(self._selection_changed)
        self.player.positionChanged.connect(self.state.set_cursor)

    # ---------------- 数据加载 / 分析 ----------------
    def _current_params(self) -> AnalysisParams:
        fmin, fmax = self.sp_fmin.value(), self.sp_fmax.value()
        if fmax <= fmin:
            fmax = fmin * 2
        return AnalysisParams(
            fmin=fmin, fmax=fmax,
            frame_ms=self.sp_frame.value(), hop_ms=self.sp_hop.value(),
            rms_floor=self.sp_rms.value(), noise_floor=self.sp_noise.value(),
            score_floor=self.sp_score.value(), octave_margin=self.sp_oct.value(),
            onset_ms=float(self.sp_onset.value()),
        )

    def _load_sample(self, idx: int) -> None:
        s = self.samples[idx]
        self.audio, self.fs = s.x.copy(), s.fs
        self.references = list(s.references)
        self.lbl_file.setText(f"内置：{s.name} — {s.description}")
        self.ref_text.setPlainText("\n".join(r.describe() for r in s.references))
        self._apply_data()

    def _open_wav(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "打开单声道 WAV", "", "WAV (*.wav)")
        if not path:
            return
        try:
            x, fs = load_wav(path)
        except Exception as e:  # 各种 scipy 解析错误统一弹窗
            QMessageBox.critical(self, "读取失败", str(e))
            return
        self.audio, self.fs = x, fs
        self.references = []
        self.lbl_file.setText(path)
        self.ref_text.setPlainText("外部 WAV 无内置分段参考。")
        self._apply_data()

    def _apply_data(self) -> None:
        duration = self.audio.size / self.fs
        self.state.reset(duration)
        self.wave.set_data(self.audio, self.fs)
        self.player.set_source(self.audio, self.fs)
        self._reanalyze()

    def _reanalyze(self) -> None:
        if self._guard or self.audio is None:
            return
        params = self._current_params()
        self.result = analyze(self.audio, self.fs, params)
        self.pitch.set_analysis(self.result, self.references)
        self.cents.set_analysis(self.result)
        n_rel = int(np.sum(self.result.reliable))
        n_unc = int(np.sum(self.result.uncertain))
        self.statusBar().showMessage(
            f"共 {len(self.result.frames)} 帧，可靠 {n_rel}，"
            f"不确定/缺口 {n_unc}；帧移 {params.hop_ms:g} ms")
        if self.state.cursor is not None:
            self._show_frame(self.state.cursor)

    # ---------------- A4 / 音名（不动 Hz） ----------------
    def _a4_changed(self, v: float) -> None:
        self.a4 = float(v)
        self.pitch.set_naming(self.a4, self.cmb_accidental.currentIndex() == 1)
        self.cents.set_a4(self.a4)
        if self.state.cursor is not None:
            self._show_frame(self.state.cursor)

    def _naming_changed(self, idx: int) -> None:
        self.pitch.set_naming(self.a4, idx == 1)
        if self.state.cursor is not None:
            self._show_frame(self.state.cursor)

    # ---------------- 帧详情 / 候选依据 ----------------
    def _show_frame(self, t: float) -> None:
        if self.result is None:
            return
        fr = self.result.frame_at(t)
        if fr is None:
            return
        prefer_flat = self.cmb_accidental.currentIndex() == 1
        self.table.setRowCount(len(fr.candidates))
        for row, c in enumerate(fr.candidates):
            vals = [
                f"{c.freq:.2f}",
                notes.freq_to_note_name(c.freq, self.a4, prefer_flat),
                f"{c.ac_peak:.3f}",
                f"{c.harm_score:.3f}",
                f"{c.f_support:.3f}",
                f"{c.score:.3f}",
                {"ac": "自相关峰", "sub": "低八度假设", "oct": "高八度假设"}.get(
                    c.source, c.source),
            ]
            for col, v in enumerate(vals):
                item = QTableWidgetItem(v)
                if row == 0:
                    item.setBackground(Qt.GlobalColor.darkGreen)
                    item.setForeground(Qt.GlobalColor.white)
                self.table.setItem(row, col, item)

        # 同一帧频率读数不随 A4 变化；变化的只有音名和音分
        if math.isfinite(fr.f0):
            shown_f, origin = fr.f0, "可靠主判断"
        elif math.isfinite(fr.f0_est):
            shown_f, origin = fr.f0_est, "不确定（估计值）"
        else:
            shown_f, origin = float("nan"), "无可靠音高（缺口）"
        if math.isfinite(shown_f):
            midi = notes.freq_to_midi(shown_f, self.a4)
            cents = float(notes.cents_from_nearest(shown_f, self.a4))
            name = notes.freq_to_note_name(shown_f, self.a4, prefer_flat)
            freq_line = (f"时间 {fr.t:.3f} s ｜ {origin}\n"
                         f"频率 {shown_f:.2f} Hz（不随 A4 改变）\n"
                         f"音名 {name} ｜ MIDI {midi:.2f} ｜ "
                         f"相对最近半音 {cents:+.1f} cent（A4={self.a4:.2f}）")
        else:
            freq_line = f"时间 {fr.t:.3f} s ｜ {origin}"
        oct_hint = ""
        if fr.candidates:
            main = fr.candidates[0]
            for c in fr.candidates[1:]:
                r = c.freq / main.freq
                if abs(r - 2.0) < 0.15 or abs(r - 0.5) < 0.15:
                    relation = "高八度" if r > 1 else "低八度"
                    oct_hint = (
                        f"\n{relation}备选 {c.freq:.2f} Hz：综合分 {c.score:.3f} "
                        f"(主判断 {main.score:.3f})，基频谱支持 {c.f_support:.3f}"
                        f"{' → 谱上无该基频能量，否决' if c.f_support < 0.12 else ''}")
        self.detail.setPlainText(
            f"{freq_line}\n"
            f"RMS {fr.rms:.4f}（门槛 {self.result.params.rms_floor:g}）｜ "
            f"频谱平坦度 {fr.flatness:.3f}（门槛 {self.result.params.noise_floor:g}）\n"
            f"判定：{'可靠' if fr.reliable else '不确定 — ' + fr.reason}"
            f"{'（起音）' if fr.is_onset else ''}{oct_hint}"
        )

    # ---------------- 视图 / 选择 / 播放 / 导出 ----------------
    def _on_view_zoom(self, factor: float, center: float) -> None:
        self.state.zoom(factor, center if center > 0 else None)

    def _selection_changed(self, t0, t1) -> None:
        if t0 is None:
            self.lbl_sel.setText("未圈选（在图上拖选；Shift+拖动平移，滚轮缩放，双击复位）")
        else:
            self.lbl_sel.setText(f"圈选 {t0:.3f} s – {t1:.3f} s（时长 {t1 - t0:.3f} s）")

    def _play_selection(self) -> None:
        if self.state.selection is None:
            self.statusBar().showMessage("请先在任一图上拖选一段时间")
            return
        t0, t1 = self.state.selection
        self.player.play_range(t0, t1)

    def _export(self) -> None:
        if self.result is None:
            return
        if self.state.selection is None:
            QMessageBox.information(self, "导出", "请先在图上拖选要导出的时间段。")
            return
        t0, t1 = self.state.selection
        path, _ = QFileDialog.getSaveFileName(
            self, "导出圈选段", "pitch_segment.csv", "CSV (*.csv)")
        if not path:
            return
        n = export_segment_csv(path, self.result, t0, t1, self.a4)
        self.statusBar().showMessage(
            f"已导出 {n} 帧到 {path}（time_sec 为真实秒，freq_hz 与 A4 无关）")
