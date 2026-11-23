"""离线扬声器→麦克风频响测量窗口。

流程: 生成/导出参考扫频 → 导入录音(或用内置合成通道生成)
→ 自动对齐反卷积 → 在 IR 上选择分析时间窗 → 查看/比较频响 → 导出。
"""
from __future__ import annotations

import json
import sys
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QDoubleSpinBox, QFileDialog,
    QFormLayout, QGroupBox, QHBoxLayout, QLabel, QMainWindow, QMessageBox,
    QPushButton, QRadioButton, QScrollArea, QSplitter, QVBoxLayout, QWidget,
)
from scipy.io import wavfile

from .dsp import (
    FilterSpec, SweepSpec, SynthSpec, analyze, generate_sweep,
    make_synthetic_recording, reference_valid_mask, synth_channel_ir,
    windowed_fr,
)
from .plots import PlotWidget

FR_NFFT = 16384
VALID_THRESH_DB = -40.0


def _spin(lo, hi, val, step=1.0, decimals=1, suffix=""):
    s = QDoubleSpinBox()
    s.setRange(lo, hi)
    s.setValue(val)
    s.setSingleStep(step)
    s.setDecimals(decimals)
    if suffix:
        s.setSuffix(suffix)
    return s


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("离线扫频测量 — 扬声器→麦克风频响")
        self.resize(1280, 860)

        self.rec = None
        self.rec_fs = None
        self.rec_name = "-"
        self.rec_is_synth = False
        self.analysis = None
        self.synth_h = None      # 合成通道设定 IR(用于偏差对比)
        self.synth_pre = 0
        self.synth_spec = None

        self._build_ui()
        self.regen_sweep()

    # ------------------------------------------------------------ UI

    def _build_ui(self):
        panel = QWidget()
        form = QVBoxLayout(panel)
        form.setSpacing(8)

        # --- 参考扫频 ---
        g = QGroupBox("参考扫频(程序生成)")
        f = QFormLayout(g)
        self.fs_combo = QComboBox()
        self.fs_combo.addItems(["44100", "48000", "96000"])
        self.fs_combo.setCurrentText("48000")
        self.f1 = _spin(5, 2000, 20, suffix=" Hz")
        self.f2 = _spin(500, 47000, 20000, step=1000, decimals=0, suffix=" Hz")
        self.dur = _spin(0.5, 20, 3.0, step=0.5, suffix=" s")
        f.addRow("采样率", self.fs_combo)
        f.addRow("起始频率", self.f1)
        f.addRow("终止频率", self.f2)
        f.addRow("时长", self.dur)
        btn = QPushButton("导出扫频 WAV…")
        btn.clicked.connect(self.on_export_sweep)
        f.addRow(btn)
        form.addWidget(g)

        # --- 录音 ---
        g = QGroupBox("录音(单声道)")
        v = QVBoxLayout(g)
        btn_imp = QPushButton("导入录音 WAV…")
        btn_imp.clicked.connect(self.on_import_rec)
        self.btn_synth = QPushButton("用内置合成通道生成录音")
        self.btn_synth.clicked.connect(self.on_make_synth)
        self.rec_info = QLabel("未加载录音")
        self.rec_info.setWordWrap(True)
        self.warn_label = QLabel("")
        self.warn_label.setWordWrap(True)
        self.warn_label.setStyleSheet("color: #c00000; font-weight: bold;")
        v.addWidget(btn_imp)
        v.addWidget(self.btn_synth)
        v.addWidget(self.rec_info)
        v.addWidget(self.warn_label)
        form.addWidget(g)

        # --- 合成通道 ---
        g = QGroupBox("内置合成通道(已知设定, 用于校验)")
        f = QFormLayout(g)
        self.sy_delay = _spin(0, 500, 5.0, step=0.1, decimals=2, suffix=" ms")
        self.sy_pre = _spin(0, 5, 0.30, step=0.1, decimals=2, suffix=" s")
        self.sy_kind = QComboBox()
        self.sy_kind.addItems(["无滤波", "低通", "高通", "峰值"])
        self.sy_fc = _spin(20, 20000, 4000, step=100, decimals=0, suffix=" Hz")
        self.sy_q = _spin(0.2, 20, 0.707, step=0.1, decimals=2)
        self.sy_gain = _spin(-24, 24, -8.0, suffix=" dB")
        self.sy_echo_on = QCheckBox("加入弱反射(回声)")
        self.sy_echo_on.setChecked(True)
        self.sy_echo_delay = _spin(1, 200, 11.0, suffix=" ms")
        self.sy_echo_gain = _spin(0.01, 0.9, 0.20, step=0.05, decimals=2)
        self.sy_noise = _spin(-120, -20, -60, step=5, decimals=0, suffix=" dBFS")
        self.sy_clip = QCheckBox("模拟削顶(演示警告)")
        f.addRow("通道延时", self.sy_delay)
        f.addRow("录音前空白", self.sy_pre)
        f.addRow("滤波", self.sy_kind)
        f.addRow("截止/中心", self.sy_fc)
        f.addRow("Q", self.sy_q)
        f.addRow("增益(峰值)", self.sy_gain)
        f.addRow(self.sy_echo_on)
        f.addRow("反射延时", self.sy_echo_delay)
        f.addRow("反射幅度", self.sy_echo_gain)
        f.addRow("噪声", self.sy_noise)
        f.addRow(self.sy_clip)
        form.addWidget(g)

        # --- 分析窗 ---
        g = QGroupBox("分析时间窗(相对主到达, ms)— 可在 IR 图上拖拽")
        f = QFormLayout(g)
        self.ir_len = _spin(20, 2000, 250, step=10, decimals=0, suffix=" ms")
        self.win_a_on = QCheckBox("启用窗 A")
        self.win_a_on.setChecked(True)
        self.a0 = _spin(-100, 2000, -1.0)
        self.a1 = _spin(-100, 5000, 30.0)
        self.win_b_on = QCheckBox("启用窗 B")
        self.win_b_on.setChecked(True)
        self.b0 = _spin(-100, 2000, -1.0)
        self.b1 = _spin(-100, 5000, 120.0)
        self.active_a = QRadioButton("拖拽设置窗 A")
        self.active_b = QRadioButton("拖拽设置窗 B")
        self.active_a.setChecked(True)
        row = QHBoxLayout()
        row.addWidget(self.active_a)
        row.addWidget(self.active_b)
        f.addRow("IR 显示长度", self.ir_len)
        f.addRow(self.win_a_on)
        f.addRow("A 起点 / 终点", self._pair(self.a0, self.a1))
        f.addRow(self.win_b_on)
        f.addRow("B 起点 / 终点", self._pair(self.b0, self.b1))
        f.addRow(row)
        form.addWidget(g)

        # --- 状态 / 导出 ---
        self.align_info = QLabel("")
        self.align_info.setWordWrap(True)
        form.addWidget(self.align_info)
        btn_exp = QPushButton("导出响应与本次分析设置…")
        btn_exp.clicked.connect(self.on_export_results)
        form.addWidget(btn_exp)
        form.addStretch(1)

        scroll = QScrollArea()
        scroll.setWidget(panel)
        scroll.setWidgetResizable(True)
        scroll.setMinimumWidth(360)
        scroll.setMaximumWidth(420)

        # --- 图区 ---
        self.ir_plot = PlotWidget(xlabel="时间 (ms, 0 = 主到达)",
                                  ylabel="IR (dB)")
        self.fr_plot = PlotWidget(logx=True, xlabel="频率 (Hz)",
                                  ylabel="幅值 (dB)")
        self.dev_plot = PlotWidget(logx=True, xlabel="频率 (Hz)",
                                   ylabel="估计 − 设定 (dB)")
        self.ir_plot.regionSelected.connect(self.on_region_selected)

        right = QSplitter(Qt.Vertical)
        right.addWidget(self.ir_plot)
        right.addWidget(self.fr_plot)
        right.addWidget(self.dev_plot)

        split = QSplitter(Qt.Horizontal)
        split.addWidget(scroll)
        split.addWidget(right)
        split.setStretchFactor(1, 1)
        self.setCentralWidget(split)

        # 参数变化 → 重新生成参考 / 重新分析
        for w in (self.f1, self.f2, self.dur):
            w.valueChanged.connect(self.regen_sweep)
        self.fs_combo.currentTextChanged.connect(self.regen_sweep)
        for w in (self.a0, self.a1, self.b0, self.b1, self.ir_len):
            w.valueChanged.connect(self.recompute)
        for w in (self.win_a_on, self.win_b_on):
            w.toggled.connect(self.recompute)

    def _pair(self, s0, s1):
        w = QWidget()
        h = QHBoxLayout(w)
        h.setContentsMargins(0, 0, 0, 0)
        h.addWidget(s0)
        h.addWidget(s1)
        return w

    # ------------------------------------------------------------ 参考扫频

    def sweep_spec(self) -> SweepSpec:
        fs = int(self.fs_combo.currentText())
        f2 = min(self.f2.value(), 0.45 * fs)
        return SweepSpec(fs=fs, f1=self.f1.value(), f2=f2,
                         duration=self.dur.value())

    def regen_sweep(self):
        spec = self.sweep_spec()
        if spec.f1 >= spec.f2:
            self.warn_label.setText("起始频率必须小于终止频率")
            return
        self.sweep = generate_sweep(spec)
        self.sweep_spec_cache = spec
        # 合成录音由本程序生成, 参考变化时同步重新生成
        if self.rec_is_synth and self.synth_spec is not None:
            self._make_synth()
        self.recompute()

    # ------------------------------------------------------------ 录音载入

    def on_export_sweep(self):
        path, _ = QFileDialog.getSaveFileName(
            self, "导出扫频 WAV", "sweep.wav", "WAV (*.wav)")
        if not path:
            return
        wavfile.write(path, self.sweep_spec_cache.fs,
                      self.sweep.astype(np.float32))
        self.align_info.setText(f"已导出扫频: {path}")

    def on_import_rec(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "导入录音 WAV", "", "WAV (*.wav)")
        if not path:
            return
        fs, data = wavfile.read(path)
        note = ""
        if data.ndim > 1:
            data = data[:, 0]
            note = "(多声道, 已取第 1 声道)"
        if data.dtype == np.int16:
            data = data.astype(np.float64) / 32768.0
        elif data.dtype == np.int32:
            data = data.astype(np.float64) / 2147483648.0
        elif data.dtype == np.uint8:
            data = (data.astype(np.float64) - 128.0) / 128.0
        else:
            data = data.astype(np.float64)
        self.rec, self.rec_fs = data, int(fs)
        self.rec_name = Path(path).name + note
        self.rec_is_synth = False
        self.synth_h = None
        self.recompute()

    def _synth_spec_from_ui(self) -> SynthSpec:
        kind = ["none", "lowpass", "highpass", "peak"][
            self.sy_kind.currentIndex()]
        return SynthSpec(
            delay_ms=self.sy_delay.value(),
            pre_silence_s=self.sy_pre.value(),
            filter=FilterSpec(kind=kind, fc=self.sy_fc.value(),
                              q=self.sy_q.value(), gain_db=self.sy_gain.value()),
            echo_on=self.sy_echo_on.isChecked(),
            echo_delay_ms=self.sy_echo_delay.value(),
            echo_gain=self.sy_echo_gain.value(),
            noise_db=self.sy_noise.value(),
            clip=self.sy_clip.isChecked())

    def on_make_synth(self):
        self.synth_spec = self._synth_spec_from_ui()
        self._make_synth()
        self.recompute()

    def _make_synth(self):
        spec = self.sweep_spec_cache
        self.rec, self.synth_h, self.synth_pre = make_synthetic_recording(
            self.sweep, spec.fs, self.synth_spec)
        self.rec_fs = spec.fs
        self.rec_name = "内置合成通道"
        self.rec_is_synth = True

    # ------------------------------------------------------------ 分析

    def recompute(self):
        self.analysis = None
        if self.rec is None:
            self.rec_info.setText("未加载录音")
            return
        peak_db = 20 * np.log10(np.abs(self.rec).max() + 1e-12)
        self.rec_info.setText(
            f"{self.rec_name}\n{self.rec_fs} Hz, "
            f"{len(self.rec) / self.rec_fs:.2f} s, 峰值 {peak_db:.1f} dBFS")
        try:
            self.analysis = analyze(self.rec, self.rec_fs, self.sweep)
        except ValueError as e:
            self.warn_label.setText(str(e))
            self._clear_plots()
            return
        self.warn_label.setText("\n".join(self.analysis.warnings))
        self._update_plots()

    def _clear_plots(self):
        for p in (self.ir_plot, self.fr_plot, self.dev_plot):
            p.set_data(curves=[], spans=[], vlines=[])

    def _update_plots(self):
        a = self.analysis
        fs = a.fs
        peak = a.peak_idx
        n_show = int(self.ir_len.value() * 1e-3 * fs)
        n_pre = int(0.005 * fs)
        idx = np.mod(peak + np.arange(-n_pre, n_show), len(a.ir))
        t_ms = np.arange(-n_pre, n_show) / fs * 1000.0
        ir_db = 20 * np.log10(np.abs(a.ir[idx]) / a.peak + 1e-6)

        spans = []
        if self.win_a_on.isChecked():
            spans.append(dict(x0=self.a0.value(), x1=self.a1.value(),
                              color="#2266cc", alpha=40, label="A"))
        if self.win_b_on.isChecked():
            spans.append(dict(x0=self.b0.value(), x1=self.b1.value(),
                              color="#dd8800", alpha=40, label="B"))
        self.ir_plot.set_data(
            curves=[dict(x=t_ms, y=ir_db, color="#333333", width=1.0,
                         label="IR (dB)")],
            spans=spans,
            vlines=[dict(x=0.0, color="#888888", dash=True)],
            xlim=(float(t_ms[0]), float(t_ms[-1])), ylim=(-100, 3))

        # 频响(两个窗共用同一 IR、同一时间零点与幅值参考)
        curves, dev_curves, fr_spans = [], [], []
        freqs = None
        valid = None
        wins = []
        if self.win_a_on.isChecked():
            wins.append(("A", self.a0.value(), self.a1.value(), "#2266cc"))
        if self.win_b_on.isChecked():
            wins.append(("B", self.b0.value(), self.b1.value(), "#dd8800"))
        tgt = {}
        if self.synth_h is not None:
            # synth_h 为有效通道(含录音电平缩放), 与估计 IR 同一幅值基准
            tgt_peak = int(np.argmax(np.abs(self.synth_h)))
        for name, t0, t1, color in wins:
            freqs, mag = windowed_fr(a.ir, peak, t0, t1, fs, FR_NFFT)
            curves.append(dict(x=freqs, y=mag, color=color,
                               label=f"窗{name} [{t0:g},{t1:g}] ms"))
            if self.synth_h is not None:
                _, mt = windowed_fr(self.synth_h, tgt_peak, t0, t1, fs, FR_NFFT)
                tgt[name] = mt
                dev_curves.append(dict(x=freqs, y=mag - mt, color=color,
                                       label=f"{name} − 设定"))
        if freqs is not None:
            valid = reference_valid_mask(self.sweep, fs, freqs,
                                         self.sweep_spec_cache.f1,
                                         self.sweep_spec_cache.f2,
                                         VALID_THRESH_DB)
            fr_spans = self._invalid_spans(freqs, valid)
            if self.synth_h is not None and tgt:
                first = wins[0]
                curves.append(dict(x=freqs, y=tgt[first[0]],
                                   color="#228822", dash=True, width=1.2,
                                   label="合成通道设定"))
        self.fr_plot.set_data(curves=curves, spans=fr_spans,
                              xlim=(max(10.0, self.sweep_spec_cache.f1 * 0.5),
                                    fs / 2.0))
        self.dev_plot.setVisible(bool(dev_curves))
        if dev_curves:
            self.dev_plot.set_data(curves=dev_curves, spans=list(fr_spans),
                                   xlim=(max(10.0, self.sweep_spec_cache.f1 * 0.5),
                                         fs / 2.0))

        # 对齐 / 时延信息
        off_ms = a.offset / fs * 1000.0
        msg = [f"扫频起点位于录音 {off_ms:.1f} ms 处, 已自动对齐; "
               "时间零点 = 主到达; 幅值为绝对校准"
               "(恒等通道 = 0 dB), 两个时间窗共用同一基准。"]
        if self.synth_h is not None and self.synth_spec is not None:
            # 与设定通道 IR 的主峰位置比(滤波器群延时本身会移动主峰,
            # 纯延时参数不是正确的对比基准)
            est = a.offset + a.peak_idx
            exp = self.synth_pre + int(np.argmax(np.abs(self.synth_h)))
            err_us = (est - exp) / fs * 1e6
            msg.append(f"合成通道: 主到达估计于录音 {est / fs * 1000:.3f} ms 处, "
                       f"与设定通道主峰偏差 {err_us:+.1f} µs。")
        if fr_spans:
            msg.append("灰色频段参考扫频能量不足 "
                       f"(< {VALID_THRESH_DB:.0f} dB), 测量不可用。")
        self.align_info.setText("\n".join(msg))

    @staticmethod
    def _invalid_spans(freqs, valid):
        spans = []
        inv = ~valid
        d = np.diff(inv.astype(int))
        starts = list(np.flatnonzero(d == 1) + 1)
        ends = list(np.flatnonzero(d == -1) + 1)
        if inv[0]:
            starts.insert(0, 0)
        if inv[-1]:
            ends.append(len(inv))
        for s, e in zip(starts, ends):
            spans.append(dict(x0=float(freqs[s]), x1=float(freqs[min(e, len(freqs) - 1)]),
                              color="#888888", alpha=60))
        return spans

    def on_region_selected(self, x0, x1):
        if self.active_a.isChecked():
            self.a0.setValue(round(x0, 1))
            self.a1.setValue(round(x1, 1))
        else:
            self.b0.setValue(round(x0, 1))
            self.b1.setValue(round(x1, 1))

    # ------------------------------------------------------------ 导出

    def on_export_results(self):
        if self.analysis is None:
            QMessageBox.warning(self, "无结果", "请先加载录音并完成分析。")
            return
        d = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not d:
            return
        out = Path(d)
        a = self.analysis
        fs = a.fs
        peak = a.peak_idx

        idx = np.mod(peak + np.arange(-int(0.01 * fs), int(1.0 * fs)),
                     len(a.ir))
        wavfile.write(str(out / "ir_full.wav"),
                      fs, a.ir[idx].astype(np.float32))

        wins = []
        if self.win_a_on.isChecked():
            wins.append(("A", self.a0.value(), self.a1.value()))
        if self.win_b_on.isChecked():
            wins.append(("B", self.b0.value(), self.b1.value()))
        cols, header = [], []
        freqs = None
        for name, t0, t1 in wins:
            freqs, mag = windowed_fr(a.ir, peak, t0, t1, fs, FR_NFFT)
            cols.append(mag)
            header.append(f"win{name}_dB")
        if freqs is not None:
            valid = reference_valid_mask(self.sweep, fs, freqs,
                                         self.sweep_spec_cache.f1,
                                         self.sweep_spec_cache.f2,
                                         VALID_THRESH_DB)
            data = np.column_stack([freqs] + cols + [valid.astype(int)])
            np.savetxt(str(out / "frequency_response.csv"), data,
                       delimiter=",",
                       header="freq_Hz," + ",".join(header) + ",valid",
                       comments="")

        settings = {
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "sweep": asdict(self.sweep_spec_cache),
            "recording": self.rec_name,
            "sweep_offset_samples": a.offset,
            "windows_ms": {n: [t0, t1] for n, t0, t1 in wins},
            "amplitude_reference": "绝对校准: 恒等通道 = 0 dB; 时间零点 = 主到达",
            "valid_band_thresh_db": VALID_THRESH_DB,
            "warnings": a.warnings,
        }
        if self.synth_spec is not None:
            settings["synth_channel"] = asdict(self.synth_spec)
        (out / "settings.json").write_text(
            json.dumps(settings, ensure_ascii=False, indent=2))
        self.align_info.setText(f"已导出到 {d}: ir_full.wav, "
                                "frequency_response.csv, settings.json")


def main():
    app = QApplication(sys.argv)
    w = MainWindow()
    w.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
