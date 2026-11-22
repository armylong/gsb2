"""PySide6 主窗口: 参考偏差分析 -> 校正参数调整 -> A/B 试听 -> 导出。"""
from __future__ import annotations

import os
import tempfile

import numpy as np
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QGridLayout,
    QPushButton, QLabel, QComboBox, QSpinBox, QDoubleSpinBox, QSlider,
    QFileDialog, QTabWidget, QTableWidget, QTableWidgetItem, QCheckBox,
    QRadioButton, QButtonGroup, QGroupBox, QMessageBox, QStatusBar, QHeaderView,
)

from .dsp import Gap
from .export import build_interval_rows, write_intervals_csv, export_corrected_wav
from .player import AudioPlayer
from .plots import DeviationPlot, WaveformPlot, MappingPlot, COLOR_GAP_SHORT, COLOR_GAP_LONG
from .sample import generate_sample
from .wavio import read_wav
from .workers import AnalysisWorker, CorrectionWorker


SLOW_MIN, SLOW_MAX = 0.05, 5.0
FAST_MIN, FAST_MAX = 0.005, 0.5


def _slider_to_tau(value: int, lo: float, hi: float) -> float:
    """0..100 的滑杆值 -> 对数尺度时间常数。"""
    return lo * (hi / lo) ** (value / 100.0)


def _tau_to_slider(tau: float, lo: float, hi: float) -> int:
    return int(round(100.0 * np.log(tau / lo) / np.log(hi / lo)))


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("参考音轨音高/带速漂移校正")
        self.resize(1280, 860)

        # 状态
        self._data: np.ndarray | None = None       # [n, ch] float
        self._sr = 48000
        self._wav_path = ""
        self._ref_ch = 0
        self._content_ch = 0
        self._an = None
        self._gaps: list[Gap] = []
        self._result = None                        # CorrectionWorker 输出
        self._analysis_worker: AnalysisWorker | None = None
        self._correction_worker: CorrectionWorker | None = None
        self._recompute_timer = QTimer(self)
        self._recompute_timer.setSingleShot(True)
        self._recompute_timer.setInterval(180)
        self._recompute_timer.timeout.connect(self._run_correction)

        self.player = AudioPlayer(self)
        self.player.positionChanged.connect(self._on_player_position)
        self.player.stateChanged.connect(self._on_player_state)

        self._build_ui()

    # ------------------------------------------------------------------ UI
    def _build_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)

        root.addWidget(self._build_file_bar())
        root.addWidget(self._build_config_bar())

        self.tabs = QTabWidget()
        root.addWidget(self.tabs, 1)
        self.tabs.addTab(self._build_tab_analysis(), "偏差轨迹与校正")
        self.tabs.addTab(self._build_tab_details(), "时间映射 / 缺口清单")

        root.addWidget(self._build_transport_bar())
        self.setStatusBar(QStatusBar())
        self.statusBar().showMessage("就绪: 打开 wav, 或点『生成可复现样例』开始")

    def _build_file_bar(self) -> QWidget:
        box = QGroupBox("1. 输入 wav (单文件内选两路: 一路内容, 一路同步参考)")
        lay = QHBoxLayout(box)
        self.btn_open = QPushButton("打开 wav…")
        self.btn_open.clicked.connect(self._open_wav)
        self.btn_sample = QPushButton("生成可复现样例并载入")
        self.btn_sample.clicked.connect(self._make_sample)
        self.lbl_file = QLabel("尚未载入文件")
        self.lbl_file.setStyleSheet("color:#555;")
        lay.addWidget(self.btn_open)
        lay.addWidget(self.btn_sample)
        lay.addWidget(self.lbl_file, 1)
        return box

    def _build_config_bar(self) -> QWidget:
        box = QGroupBox("2. 通道与参考音参数")
        grid = QGridLayout(box)

        grid.addWidget(QLabel("参考轨通道"), 0, 0)
        self.cmb_ref = QComboBox()
        grid.addWidget(self.cmb_ref, 0, 1)
        grid.addWidget(QLabel("内容轨通道"), 0, 2)
        self.cmb_content = QComboBox()
        grid.addWidget(self.cmb_content, 0, 3)

        grid.addWidget(QLabel("参考标称频率 (Hz)"), 0, 4)
        self.spn_fnom = QDoubleSpinBox()
        self.spn_fnom.setRange(20.0, 20000.0)
        self.spn_fnom.setValue(1000.0)
        self.spn_fnom.setDecimals(2)
        grid.addWidget(self.spn_fnom, 0, 5)

        grid.addWidget(QLabel("有效门限: 窄带电平(dBFS)"), 1, 0)
        self.spn_level = QDoubleSpinBox()
        self.spn_level.setRange(-120.0, -10.0)
        self.spn_level.setValue(-55.0)
        grid.addWidget(self.spn_level, 1, 1)

        grid.addWidget(QLabel("窄带/宽带差(dB)"), 1, 2)
        self.spn_snr = QDoubleSpinBox()
        self.spn_snr.setRange(-60.0, 20.0)
        self.spn_snr.setValue(-12.0)
        grid.addWidget(self.spn_snr, 1, 3)

        grid.addWidget(QLabel("纯度门限"), 1, 4)
        self.spn_purity = QDoubleSpinBox()
        self.spn_purity.setRange(0.01, 1.0)
        self.spn_purity.setSingleStep(0.05)
        self.spn_purity.setValue(0.25)
        grid.addWidget(self.spn_purity, 1, 5)

        self.btn_analyze = QPushButton("分析参考轨")
        self.btn_analyze.setEnabled(False)
        self.btn_analyze.clicked.connect(self._run_analysis)
        grid.addWidget(self.btn_analyze, 1, 6)

        self.cmb_ref.currentIndexChanged.connect(self._on_channel_pick)
        self.cmb_content.currentIndexChanged.connect(self._on_channel_pick)
        return box

    def _build_tab_analysis(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)

        # 偏差轨迹
        dev_box = QGroupBox("3. 参考频率偏差轨迹(蓝=可信, 橙=太弱/太脏, 红=噪声/丢失)")
        dv = QVBoxLayout(dev_box)
        unit_row = QHBoxLayout()
        unit_row.addWidget(QLabel("偏差单位"))
        self.cmb_unit = QComboBox()
        self.cmb_unit.addItems(["Hz", "音分(cents)"])
        self.cmb_unit.currentIndexChanged.connect(self._refresh_deviation_plot)
        unit_row.addWidget(self.cmb_unit)
        unit_row.addStretch(1)
        dv.addLayout(unit_row)
        self.dev_plot = DeviationPlot()
        self.dev_plot.seekRequested.connect(self._seek)
        dv.addWidget(self.dev_plot)
        lay.addWidget(dev_box, 3)

        # 校正参数
        corr_box = QGroupBox("4. 校正跟随程度 (慢漂移 / 快抖动) 与缺口处理")
        gl = QGridLayout(corr_box)

        gl.addWidget(QLabel("慢漂时间常数 τ (s, 越大越只跟很慢的漂移)"), 0, 0)
        self.sld_slow = QSlider(Qt.Horizontal)
        self.sld_slow.setRange(0, 100)
        self.sld_slow.setValue(_tau_to_slider(0.8, SLOW_MIN, SLOW_MAX))
        self.lbl_slow = QLabel()
        self.sld_slow.valueChanged.connect(self._on_param_changed)
        gl.addWidget(self.sld_slow, 0, 1)
        gl.addWidget(self.lbl_slow, 0, 2)

        gl.addWidget(QLabel("快抖动时间常数 τ (s)"), 1, 0)
        self.sld_fast = QSlider(Qt.Horizontal)
        self.sld_fast.setRange(0, 100)
        self.sld_fast.setValue(_tau_to_slider(0.03, FAST_MIN, FAST_MAX))
        self.lbl_fast = QLabel()
        self.sld_fast.valueChanged.connect(self._on_param_changed)
        gl.addWidget(self.sld_fast, 1, 1)
        gl.addWidget(self.lbl_fast, 1, 2)

        gl.addWidget(QLabel("快抖动跟随量 (0=只修慢漂, 1=慢漂+全部快抖)"), 2, 0)
        self.sld_amount = QSlider(Qt.Horizontal)
        self.sld_amount.setRange(0, 100)
        self.sld_amount.setValue(100)
        self.lbl_amount = QLabel()
        self.sld_amount.valueChanged.connect(self._on_param_changed)
        gl.addWidget(self.sld_amount, 2, 1)
        gl.addWidget(self.lbl_amount, 2, 2)

        self.chk_bridge = QCheckBox("短缺口平滑跨过 (取消则短缺口也原样保留)")
        self.chk_bridge.setChecked(True)
        self.chk_bridge.stateChanged.connect(self._on_param_changed)
        gl.addWidget(self.chk_bridge, 3, 0, 1, 3)

        edge_row = QHBoxLayout()
        edge_row.addWidget(QLabel("头/尾无参考时:"))
        self.rb_zero = QRadioButton("不校正(推荐)")
        self.rb_hold = QRadioButton("保持最近有效速率")
        self.rb_zero.setChecked(True)
        self.edge_group = QButtonGroup(self)
        self.edge_group.addButton(self.rb_zero)
        self.edge_group.addButton(self.rb_hold)
        self.rb_zero.toggled.connect(self._on_param_changed)
        edge_row.addWidget(self.rb_zero)
        edge_row.addWidget(self.rb_hold)
        edge_row.addStretch(1)
        gl.addLayout(edge_row, 4, 0, 1, 3)
        lay.addWidget(corr_box)

        # 波形
        wave_box = QGroupBox("5. 波形与打点事件 (可叠加对比轨; 点击图任意位置可跳转)")
        wv = QVBoxLayout(wave_box)
        overlay_row = QHBoxLayout()
        self.chk_overlay = QCheckBox("叠加显示另一轨(半透明)")
        self.chk_overlay.stateChanged.connect(self._refresh_waveform)
        overlay_row.addWidget(self.chk_overlay)
        overlay_row.addStretch(1)
        wv.addLayout(overlay_row)
        self.wave_plot = WaveformPlot()
        self.wave_plot.seekRequested.connect(self._seek)
        wv.addWidget(self.wave_plot)
        lay.addWidget(wave_box, 3)
        self._update_param_labels()
        return w

    def _build_tab_details(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)

        map_box = QGroupBox("6. 校正前后时间对应 (虚线 y=x 为无校正; 灰段=未校正/原样保留)")
        ml = QVBoxLayout(map_box)
        self.map_plot = MappingPlot()
        self.map_plot.seekRequested.connect(self._seek)
        ml.addWidget(self.map_plot)
        lay.addWidget(map_box, 3)

        gap_box = QGroupBox("7. 参考缺失区间清单 (长缺口不插值、原样保留)")
        gl = QVBoxLayout(gap_box)
        self.tbl_gaps = QTableWidget(0, 5)
        self.tbl_gaps.setHorizontalHeaderLabels(
            ["起点(s)", "终点(s)", "时长(s)", "类型", "处理方式"])
        self.tbl_gaps.horizontalHeader().setSectionResizeMode(
            QHeaderView.Stretch)
        self.tbl_gaps.setSelectionBehavior(QTableWidget.SelectRows)
        gl.addWidget(self.tbl_gaps)
        hint = QLabel("提示: 双击表中某行可跳转到该区间起点。")
        hint.setStyleSheet("color:#666;")
        gl.addWidget(hint)
        self.tbl_gaps.cellDoubleClicked.connect(self._jump_gap_row)
        lay.addWidget(gap_box, 2)
        return w

    def _build_transport_bar(self) -> QWidget:
        box = QGroupBox("8. A/B 试听与导出 (原始/校正停在同一输入时间位置)")
        lay = QHBoxLayout(box)
        self.btn_play = QPushButton("▶ 播放")
        self.btn_play.setEnabled(False)
        self.btn_play.clicked.connect(self._toggle_play)
        self.btn_track = QPushButton("当前: 原始轨 (点此切换为校正轨)")
        self.btn_track.setEnabled(False)
        self.btn_track.clicked.connect(self._toggle_track)
        self.lbl_pos = QLabel("0.000 s")
        lay.addWidget(self.btn_play)
        lay.addWidget(self.btn_track)
        lay.addWidget(self.lbl_pos)
        lay.addStretch(1)

        self.btn_export = QPushButton("导出校正 wav + 有效区间 CSV…")
        self.btn_export.setEnabled(False)
        self.btn_export.clicked.connect(self._export)
        lay.addWidget(self.btn_export)
        return box

    # ------------------------------------------------------------ 文件载入
    def _open_wav(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择 wav", "", "WAV 文件 (*.wav *.WAV)")
        if path:
            self._load_wav(path)

    def _make_sample(self):
        d = tempfile.mkdtemp(prefix="pitchcorrect_sample_")
        wav_path = os.path.join(d, "sample_stereo.wav")
        json_path = os.path.join(d, "sample_groundtruth.json")
        try:
            generate_sample(wav_path, json_path=json_path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "样例生成失败", str(exc))
            return
        self._load_wav(wav_path)
        # 样例默认: ch1 参考 1000Hz, ch0 内容
        self.cmb_ref.setCurrentIndex(min(1, self._data.shape[1] - 1))
        self.cmb_content.setCurrentIndex(0)
        self.spn_fnom.setValue(1000.0)
        self.statusBar().showMessage(
            f"样例已生成: {wav_path}\n地面真值: {json_path}")

    def _load_wav(self, path: str):
        try:
            data, sr = read_wav(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "读取失败", str(exc))
            return
        self.player.stop()
        self._data, self._sr, self._wav_path = data, sr, path
        self._an, self._gaps, self._result = None, [], None
        n_ch = data.shape[1]
        for cmb in (self.cmb_ref, self.cmb_content):
            cmb.blockSignals(True)
            cmb.clear()
            cmb.addItems([f"通道 {i}" for i in range(n_ch)])
            cmb.blockSignals(False)
        self.cmb_ref.setCurrentIndex(min(1, n_ch - 1))
        self.cmb_content.setCurrentIndex(0)
        self.lbl_file.setText(
            f"{os.path.basename(path)}  |  {sr} Hz, {n_ch} 声道, "
            f"{data.shape[0] / sr:.2f} s")
        self.btn_analyze.setEnabled(n_ch >= 1)
        self.btn_play.setEnabled(False)
        self.btn_track.setEnabled(False)
        self.btn_export.setEnabled(False)
        self.dev_plot.set_data([], [], [], self.spn_fnom.value())
        self.wave_plot.set_waveforms(sr, np.zeros(sr))
        self.map_plot.set_mapping(np.array([0.0, 1.0]), np.array([0.0, 1.0]))
        self.tbl_gaps.setRowCount(0)
        self.statusBar().showMessage("已载入, 请选择参考/内容通道并分析")

    def _on_channel_pick(self):
        if self._data is None:
            return
        self._ref_ch = self.cmb_ref.currentIndex()
        self._content_ch = self.cmb_content.currentIndex()

    # ------------------------------------------------------------ 分析流程
    def _run_analysis(self):
        if self._data is None:
            return
        if self.cmb_ref.currentIndex() == self.cmb_content.currentIndex() \
                and self._data.shape[1] > 1:
            QMessageBox.warning(
                self, "通道冲突", "参考轨与内容轨不能是同一路, 请重新选择。")
            return
        self.player.stop()
        self.btn_analyze.setEnabled(False)
        self.statusBar().showMessage("正在分析参考轨…")
        ref = np.ascontiguousarray(self._data[:, self.cmb_ref.currentIndex()])
        self._analysis_worker = AnalysisWorker(
            ref, self._sr, self.spn_fnom.value(),
            self.spn_level.value(), self.spn_snr.value(),
            self.spn_purity.value())
        self._analysis_worker.finished_ok.connect(self._on_analysis_done)
        self._analysis_worker.failed.connect(self._on_analysis_failed)
        self._analysis_worker.start()

    def _on_analysis_done(self, an, gaps):
        self._an, self._gaps = an, gaps
        self.btn_analyze.setEnabled(True)
        self._refresh_deviation_plot()
        self._fill_gap_table()
        self.statusBar().showMessage(
            f"分析完成: 有效帧 {an.valid.mean():.1%}, "
            f"短缺口 {sum(g.kind == 'short' for g in gaps)} 个, "
            f"长缺口 {sum(g.kind == 'long' for g in gaps)} 个。正在校正…")
        self._run_correction()

    def _on_analysis_failed(self, msg: str):
        self.btn_analyze.setEnabled(True)
        self.statusBar().showMessage("分析失败")
        QMessageBox.critical(self, "参考轨分析失败", msg)

    # ------------------------------------------------------------ 校正流程
    def _current_params(self) -> dict:
        return {
            "slow_tau": _slider_to_tau(self.sld_slow.value(),
                                       SLOW_MIN, SLOW_MAX),
            "fast_tau": _slider_to_tau(self.sld_fast.value(),
                                       FAST_MIN, FAST_MAX),
            "fast_amount": self.sld_amount.value() / 100.0,
            "bridge_short": self.chk_bridge.isChecked(),
            "edge_mode": "hold" if self.rb_hold.isChecked() else "zero",
        }

    def _update_param_labels(self):
        p = self._current_params() if self._an else {
            "slow_tau": _slider_to_tau(self.sld_slow.value(),
                                       SLOW_MIN, SLOW_MAX),
            "fast_tau": _slider_to_tau(self.sld_fast.value(),
                                       FAST_MIN, FAST_MAX),
            "fast_amount": self.sld_amount.value() / 100.0}
        self.lbl_slow.setText(f"{p['slow_tau']:.3f} s")
        self.lbl_fast.setText(f"{p['fast_tau']:.3f} s")
        self.lbl_amount.setText(f"{p['fast_amount']:.2f}")

    def _on_param_changed(self):
        self._update_param_labels()
        if self._an is not None:
            self._recompute_timer.start()   # 防抖: 滑杆连续变化后再重算

    def _run_correction(self):
        if self._an is None:
            return
        content = np.ascontiguousarray(
            self._data[:, self.cmb_content.currentIndex()])
        self.btn_export.setEnabled(False)
        self.statusBar().showMessage("正在按参考偏差重采样校正…")
        self._correction_worker = CorrectionWorker(
            content, self._sr, self._an, self._gaps, self._current_params())
        self._correction_worker.finished_ok.connect(self._on_correction_done)
        self._correction_worker.failed.connect(self._on_correction_failed)
        self._correction_worker.start()

    def _on_correction_done(self, result: dict):
        self._result = result
        corr = result["corr"]
        content = np.ascontiguousarray(
            self._data[:, self.cmb_content.currentIndex()])
        self.player.set_tracks(self._sr, content, corr["out"])
        self.btn_play.setEnabled(True)
        self.btn_track.setEnabled(True)
        self.btn_export.setEnabled(True)
        self._refresh_waveform()
        self._refresh_mapping()
        n_long = sum(g.kind == "long" for g in self._gaps)
        self.statusBar().showMessage(
            f"校正完成。时间映射严格单调: "
            f"{bool(np.all(np.diff(corr['map_in_to_out']) > 0))}; "
            f"长缺口 {n_long} 段原样保留。可 A/B 试听或导出。")

    def _on_correction_failed(self, msg: str):
        self.statusBar().showMessage("校正失败")
        QMessageBox.critical(self, "校正失败", msg)

    # ------------------------------------------------------------ 图表刷新
    def _refresh_deviation_plot(self):
        if self._an is None:
            return
        unit = "cents" if self.cmb_unit.currentIndex() == 1 else "hz"
        self.dev_plot.set_data(self._an.frame_time, self._an.deviation,
                               self._an.weak, self._an.f_nom, unit)
        # 缺口背景着色
        regions = []
        for g in self._gaps:
            color = COLOR_GAP_SHORT if g.kind == "short" else COLOR_GAP_LONG
            regions.append((g.start, g.end, color))
        self.dev_plot.set_regions(regions)
        self.dev_plot.set_duration(self._data.shape[0] / self._sr)

    def _refresh_waveform(self):
        if self._result is None:
            return
        corr = self._result["corr"]
        content = np.ascontiguousarray(
            self._data[:, self.cmb_content.currentIndex()])
        overlay = self.chk_overlay.isChecked()
        # 当前播放哪轨, 主波形就显示哪轨
        if self.player._current == "corrected":
            primary, secondary = corr["out"], content
            ev_p, ev_s = self._result["events_after"], self._result["events_before"]
        else:
            primary, secondary = content, corr["out"]
            ev_p, ev_s = self._result["events_before"], self._result["events_after"]
        self.wave_plot.set_waveforms(
            self._sr, primary,
            secondary if overlay else None,
            ev_p, ev_s if overlay else None)
        self.wave_plot.set_show_secondary(overlay)
        # 未校正区间在波形图上同样着色
        regions = [(a, b, COLOR_GAP_LONG) for a, b in self._result["uncorr"]]
        self.wave_plot.set_regions(regions)

    def _refresh_mapping(self):
        if self._result is None:
            return
        corr = self._result["corr"]
        n = corr["map_in_to_out"].size
        # 抽稀到 ~4000 点供绘图
        step = max(1, n // 4000)
        t_in = np.arange(n)[::step] / self._sr
        t_out = corr["map_in_to_out"][::step]
        mask = corr["corrected_mask"][::step]
        self.map_plot.set_mapping(t_in, t_out, ~mask)

    def _fill_gap_table(self):
        self.tbl_gaps.setRowCount(len(self._gaps))
        bridge = self.chk_bridge.isChecked()
        for row, g in enumerate(self._gaps):
            kind = "短缺口" if g.kind == "short" else "长缺口"
            if g.kind == "long":
                handling = "不插值, 原样保留"
            else:
                handling = "平滑跨过" if bridge else "按设置原样保留"
            vals = [f"{g.start:.3f}", f"{g.end:.3f}", f"{g.duration:.3f}",
                    kind, handling]
            for col, v in enumerate(vals):
                item = QTableWidgetItem(v)
                if g.kind == "long":
                    item.setForeground(QColor("#b02a37"))
                self.tbl_gaps.setItem(row, col, item)

    def _jump_gap_row(self, row: int, _col: int):
        if 0 <= row < len(self._gaps):
            self._seek(self._gaps[row].start)

    # ------------------------------------------------------------ 播放控制
    def _toggle_play(self):
        if self.player.is_playing():
            self.player.stop()
        else:
            self.player.play()

    def _on_player_state(self, state: str):
        self.btn_play.setText("⏸ 停止" if state == "playing" else "▶ 播放")

    def _toggle_track(self):
        if self.player._current == "original":
            self.player.switch_track("corrected")
            self.btn_track.setText("当前: 校正轨 (点此切回原始轨)")
        else:
            self.player.switch_track("original")
            self.btn_track.setText("当前: 原始轨 (点此切换为校正轨)")
        self._refresh_waveform()

    def _seek(self, t: float):
        self.player.seek(float(t))
        self._update_cursors(float(t))

    def _on_player_position(self, t: float):
        self.lbl_pos.setText(f"{t:.3f} s")
        self._update_cursors(float(t))

    def _update_cursors(self, t: float):
        self.dev_plot.set_cursor(t)
        self.wave_plot.set_cursor(t)
        self.map_plot.set_cursor(t)

    # ------------------------------------------------------------ 导出
    def _export(self):
        if self._result is None or self._an is None:
            return
        d = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not d:
            return
        base = os.path.splitext(os.path.basename(self._wav_path))[0] or "audio"
        wav_out = os.path.join(d, f"{base}_corrected_mono.wav")
        csv_out = os.path.join(d, f"{base}_reference_intervals.csv")
        try:
            corr = self._result["corr"]
            export_corrected_wav(wav_out, corr["out"], self._sr)
            params = self._current_params()
            rows = build_interval_rows(
                self._an, self._gaps, self._data.shape[0] / self._sr,
                bridge_short=params["bridge_short"],
                edge_mode=params["edge_mode"])
            write_intervals_csv(csv_out, rows)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        mono_ok = bool(np.all(np.diff(corr["map_in_to_out"]) > 0))
        QMessageBox.information(
            self, "导出完成",
            f"单声道校正 wav:\n{wav_out}\n\n有效参考区间表(覆盖全时间轴):\n"
            f"{csv_out}\n\n时间映射严格单调向前: {mono_ok}")


def main():
    import sys
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
