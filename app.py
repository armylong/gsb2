"""三段均衡器 GUI (PySide6 + matplotlib)。

实时试听与频响曲线联动: 曲线由实际处理所用的同一套系数计算;
导出与试听使用同一 process_offline/design_stages, 参数状态一致。
"""
from __future__ import annotations

import math
import sys

import numpy as np
import matplotlib

# macOS 中文字体, 避免图表内中文显示为方块
matplotlib.rcParams["font.family"] = [
    "PingFang SC", "Hiragino Sans GB", "Arial Unicode MS", "DejaVu Sans",
]
matplotlib.rcParams["axes.unicode_minus"] = False

from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QDoubleSpinBox, QFileDialog, QGroupBox,
    QHBoxLayout, QLabel, QMainWindow, QMessageBox, QPushButton, QSlider,
    QVBoxLayout, QWidget,
)
from matplotlib.backends.backend_qtagg import FigureCanvasQTAgg as FigureCanvas
from matplotlib.figure import Figure
from scipy.io import wavfile

import testtones
from eq_dsp import (
    EQParams, MAX_GAIN_DB, MAX_Q, MIN_FREQ, MIN_Q, band_response_db,
    clamp_params, freq_response_db, max_freq, process_offline,
)
from player import Player

MAX_DURATION = 15.0
SUPPORTED_SR = (44100, 48000)


def db_str(x: float) -> str:
    return f"{20 * math.log10(x):+.1f} dBFS" if x > 1e-9 else "-inf dBFS"


class BandBox(QGroupBox):
    """单段控制组: 启用 / 频率 / 增益 (/ Q)。"""

    def __init__(self, title: str, has_q: bool, on_change):
        super().__init__(title)
        self.on_change = on_change
        self._building = True
        lay = QVBoxLayout(self)

        self.enable = QCheckBox("启用")
        self.enable.setChecked(True)
        self.enable.toggled.connect(self._changed)
        lay.addWidget(self.enable)

        self.freq_slider, self.freq_spin = self._row(lay, "频率", self._freq_changed)
        self.gain_slider, self.gain_spin = self._row(lay, "增益", self._gain_changed)
        self.gain_spin.setSuffix(" dB")
        self.gain_spin.setDecimals(1)
        self.gain_spin.setSingleStep(0.5)

        self.q_slider = self.q_spin = None
        if has_q:
            self.q_slider, self.q_spin = self._row(lay, "带宽 Q", self._q_changed)
            self.q_spin.setDecimals(2)
            self.q_spin.setSingleStep(0.1)
        self._building = False

    def _row(self, lay, label, slot):
        row = QHBoxLayout()
        row.addWidget(QLabel(label))
        slider = QSlider(Qt.Horizontal)
        spin = QDoubleSpinBox()
        row.addWidget(slider, 1)
        row.addWidget(spin)
        lay.addLayout(row)
        slider.valueChanged.connect(slot)
        spin.valueChanged.connect(slot)
        return slider, spin

    def configure_ranges(self, fmax: float):
        self._fmin, self._fmax = MIN_FREQ, fmax
        self.freq_spin.setRange(MIN_FREQ, fmax)
        self.freq_spin.setSuffix(" Hz")
        self.freq_spin.setDecimals(1)
        self.freq_slider.setRange(0, 1000)
        self.gain_spin.setRange(-MAX_GAIN_DB, MAX_GAIN_DB)
        self.gain_slider.setRange(-int(MAX_GAIN_DB * 10), int(MAX_GAIN_DB * 10))
        if self.q_spin:
            self.q_spin.setRange(MIN_Q, MAX_Q)
            self.q_slider.setRange(int(MIN_Q * 100), int(MAX_Q * 100))

    # 频率滑杆用对数映射
    def _freq_to_slider(self, f):
        return int(round(1000 * math.log(f / self._fmin) / math.log(self._fmax / self._fmin)))

    def _slider_to_freq(self, v):
        return self._fmin * (self._fmax / self._fmin) ** (v / 1000)

    def _changed(self, *_):
        if not self._building:
            self.on_change()

    def _freq_changed(self, v):
        if self._building:
            return
        sender = self.sender()
        self._building = True
        if sender is self.freq_slider:
            self.freq_spin.setValue(self._slider_to_freq(v))
        else:
            self.freq_slider.setValue(self._freq_to_slider(v))
        self._building = False
        self.on_change()

    def _gain_changed(self, v):
        if self._building:
            return
        self._building = True
        if self.sender() is self.gain_slider:
            self.gain_spin.setValue(v / 10.0)
        else:
            self.gain_slider.setValue(int(round(v * 10)))
        self._building = False
        self.on_change()

    def _q_changed(self, v):
        if self._building:
            return
        self._building = True
        if self.sender() is self.q_slider:
            self.q_spin.setValue(v / 100.0)
        else:
            self.q_slider.setValue(int(round(v * 100)))
        self._building = False
        self.on_change()

    def set_values(self, enabled, freq, gain, q=None):
        self._building = True
        self.enable.setChecked(enabled)
        self.freq_spin.setValue(freq)
        self.freq_slider.setValue(self._freq_to_slider(freq))
        self.gain_spin.setValue(gain)
        self.gain_slider.setValue(int(round(gain * 10)))
        if q is not None and self.q_spin:
            self.q_spin.setValue(q)
            self.q_slider.setValue(int(round(q * 100)))
        self._building = False


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("三段均衡器 (低架 / 峰值 / 高架)")
        self.player = Player()
        self.data: np.ndarray | None = None
        self.sr = 0
        self.params: EQParams | None = None
        self._press_x = None
        self._loop_region = None

        root = QWidget()
        self.setCentralWidget(root)
        main = QVBoxLayout(root)

        # ---- 文件行 ----
        row = QHBoxLayout()
        btn_open = QPushButton("打开 WAV…")
        btn_open.clicked.connect(self.open_file)
        btn_tone = QPushButton("生成多频测试音")
        btn_tone.clicked.connect(lambda: self.load_data(testtones.multitone(44100, 6.0), 44100, "多频测试音 44.1kHz"))
        btn_stereo = QPushButton("生成立体声测试音")
        btn_stereo.clicked.connect(lambda: self.load_data(testtones.stereo_test(48000, 6.0), 48000, "立体声测试音 48kHz"))
        self.file_label = QLabel("未加载文件")
        row.addWidget(btn_open)
        row.addWidget(btn_tone)
        row.addWidget(btn_stereo)
        row.addWidget(self.file_label, 1)
        main.addLayout(row)

        # ---- 传输行 ----
        row = QHBoxLayout()
        self.btn_play = QPushButton("播放")
        self.btn_play.clicked.connect(self.toggle_play)
        btn_stop = QPushButton("停止")
        btn_stop.clicked.connect(self.stop)
        self.loop_check = QCheckBox("循环选区")
        self.loop_check.toggled.connect(self._loop_toggled)
        btn_clear_loop = QPushButton("清除选区")
        btn_clear_loop.clicked.connect(self.clear_loop)
        self.time_label = QLabel("--:--.- / --:--.-")
        self.bypass = QCheckBox("旁路 (原声对比)")
        self.bypass.setStyleSheet("QCheckBox { font-weight: bold; } QCheckBox:checked { color: #c0392b; }")
        self.bypass.toggled.connect(self.on_params_changed)
        for w in (self.btn_play, btn_stop, self.loop_check, btn_clear_loop, self.time_label):
            row.addWidget(w)
        row.addStretch(1)
        row.addWidget(self.bypass)
        main.addLayout(row)

        # ---- 总增益 / 峰值行 ----
        row = QHBoxLayout()
        row.addWidget(QLabel("总输出增益"))
        self.master_slider = QSlider(Qt.Horizontal)
        self.master_slider.setRange(-int(MAX_GAIN_DB * 10), int(MAX_GAIN_DB * 10))
        self.master_spin = QDoubleSpinBox()
        self.master_spin.setRange(-MAX_GAIN_DB, MAX_GAIN_DB)
        self.master_spin.setSuffix(" dB")
        self.master_spin.setDecimals(1)
        self.master_spin.setSingleStep(0.5)
        self.master_slider.valueChanged.connect(self._master_slider)
        self.master_spin.valueChanged.connect(self._master_spin)
        self.peak_label = QLabel("峰值: --")
        self.clip_label = QLabel("超幅!")
        self.clip_label.setStyleSheet("color: white; background: #c0392b; font-weight: bold; padding: 2px 6px;")
        self.clip_label.setVisible(False)
        btn_peak_reset = QPushButton("重置峰值")
        btn_peak_reset.clicked.connect(self._reset_peak)
        btn_export = QPushButton("导出 WAV…")
        btn_export.clicked.connect(self.export_wav)
        row.addWidget(self.master_slider, 1)
        row.addWidget(self.master_spin)
        row.addWidget(self.peak_label)
        row.addWidget(self.clip_label)
        row.addWidget(btn_peak_reset)
        row.addWidget(btn_export)
        main.addLayout(row)

        # ---- 波形图 ----
        self.wave_fig = Figure(figsize=(8, 1.8), constrained_layout=True)
        self.wave_canvas = FigureCanvas(self.wave_fig)
        self.wave_ax = self.wave_fig.add_subplot(111)
        self.wave_canvas.mpl_connect("button_press_event", self._wave_press)
        self.wave_canvas.mpl_connect("button_release_event", self._wave_release)
        main.addWidget(self.wave_canvas)

        # ---- 频响图 ----
        self.fr_fig = Figure(figsize=(8, 2.6), constrained_layout=True)
        self.fr_canvas = FigureCanvas(self.fr_fig)
        self.fr_ax = self.fr_fig.add_subplot(111)
        main.addWidget(self.fr_canvas)

        # ---- 三段控制 ----
        row = QHBoxLayout()
        self.band_low = BandBox("低架 Low Shelf", has_q=False, on_change=self.on_params_changed)
        self.band_mid = BandBox("峰值 Peaking", has_q=True, on_change=self.on_params_changed)
        self.band_high = BandBox("高架 High Shelf", has_q=False, on_change=self.on_params_changed)
        row.addWidget(self.band_low)
        row.addWidget(self.band_mid)
        row.addWidget(self.band_high)
        main.addLayout(row)

        # 频响图刷新节流
        self._fr_timer = QTimer(self)
        self._fr_timer.setSingleShot(True)
        self._fr_timer.setInterval(30)
        self._fr_timer.timeout.connect(self.update_freq_response)

        # 播放头 / 峰值刷新
        self._ui_timer = QTimer(self)
        self._ui_timer.setInterval(33)
        self._ui_timer.timeout.connect(self._tick)
        self._ui_timer.start()

        self.resize(1000, 860)
        # 默认载入一个测试音, 方便直接试听
        self.load_data(testtones.stereo_test(44100, 6.0), 44100, "立体声测试音 44.1kHz")

    # ---- 文件 ----
    def open_file(self):
        path, _ = QFileDialog.getOpenFileName(self, "打开 WAV", "", "WAV 文件 (*.wav)")
        if not path:
            return
        try:
            sr, data = wavfile.read(path)
        except Exception as e:
            QMessageBox.warning(self, "无法读取", str(e))
            return
        if sr not in SUPPORTED_SR:
            QMessageBox.warning(self, "采样率不支持", f"仅支持 44.1kHz / 48kHz, 当前为 {sr}Hz")
            return
        if data.ndim > 2 or (data.ndim == 2 and data.shape[1] > 2):
            QMessageBox.warning(self, "声道数不支持", "仅支持单声道或立体声")
            return
        dur = len(data) / sr
        if dur > MAX_DURATION:
            QMessageBox.warning(self, "文件过长", f"最长 {MAX_DURATION:.0f} 秒, 当前 {dur:.1f} 秒")
            return
        if data.dtype == np.int16:
            x = data.astype(np.float32) / 32768.0
        elif data.dtype == np.int32:
            x = data.astype(np.float32) / 2147483648.0
        elif data.dtype in (np.float32, np.float64):
            x = data.astype(np.float32)
        else:
            QMessageBox.warning(self, "格式不支持", f"不支持的采样格式: {data.dtype}")
            return
        self.load_data(x, sr, path.split("/")[-1])

    def load_data(self, data: np.ndarray, sr: int, name: str):
        self.stop()
        self.data = np.asarray(data, dtype=np.float32)
        if self.data.ndim == 1:
            self.data = self.data[:, None]
        self.sr = sr
        self.player.load(self.data, sr)
        self._loop_region = None
        self.loop_check.setChecked(False)

        fmax = max_freq(sr)
        for box in (self.band_low, self.band_mid, self.band_high):
            box.configure_ranges(fmax)
        p = EQParams.default(sr)
        self.band_low.set_values(p.low.enabled, p.low.freq, p.low.gain_db)
        self.band_mid.set_values(p.mid.enabled, p.mid.freq, p.mid.gain_db, p.mid.q)
        self.band_high.set_values(p.high.enabled, min(p.high.freq, fmax), p.high.gain_db)
        self.master_spin.setValue(0.0)
        self.master_slider.setValue(0)
        self.bypass.setChecked(False)

        dur = len(self.data) / sr
        ch = "单声道" if self.data.shape[1] == 1 else "立体声"
        self.file_label.setText(f"{name}  |  {sr} Hz {ch}  {dur:.1f}s")
        self.draw_waveform()
        self.on_params_changed()

    # ---- 参数 ----
    def collect_params(self) -> EQParams:
        p = EQParams.default(self.sr)
        p.low.enabled = self.band_low.enable.isChecked()
        p.low.freq = self.band_low.freq_spin.value()
        p.low.gain_db = self.band_low.gain_spin.value()
        p.mid.enabled = self.band_mid.enable.isChecked()
        p.mid.freq = self.band_mid.freq_spin.value()
        p.mid.gain_db = self.band_mid.gain_spin.value()
        p.mid.q = self.band_mid.q_spin.value()
        p.high.enabled = self.band_high.enable.isChecked()
        p.high.freq = self.band_high.freq_spin.value()
        p.high.gain_db = self.band_high.gain_spin.value()
        p.master_gain_db = self.master_spin.value()
        p.bypass = self.bypass.isChecked()
        return clamp_params(p, self.sr)

    def on_params_changed(self, *_):
        if self.sr == 0:
            return
        self.params = self.collect_params()
        if self.player.chain is not None:
            self.player.chain.set_params(self.params)
        self._fr_timer.start()

    def _master_slider(self, v):
        self.master_spin.blockSignals(True)
        self.master_spin.setValue(v / 10.0)
        self.master_spin.blockSignals(False)
        self.on_params_changed()

    def _master_spin(self, v):
        self.master_slider.blockSignals(True)
        self.master_slider.setValue(int(round(v * 10)))
        self.master_slider.blockSignals(False)
        self.on_params_changed()

    # ---- 传输 ----
    def toggle_play(self):
        if self.player.playing:
            self.player.pause()
            self.btn_play.setText("播放")
        else:
            self.player.play()
            self.btn_play.setText("暂停")

    def stop(self):
        self.player.stop()
        self.btn_play.setText("播放")

    def _loop_toggled(self, on):
        if on and self._loop_region:
            self.player.set_loop(*self._loop_region)
        elif not on:
            self.player.clear_loop()

    def clear_loop(self):
        self._loop_region = None
        self.loop_check.setChecked(False)
        self.player.clear_loop()
        self._draw_loop_region()

    # ---- 波形 ----
    def draw_waveform(self):
        ax = self.wave_ax
        ax.clear()
        if self.data is None:
            return
        n = len(self.data)
        dur = n / self.sr
        t = np.linspace(0, dur, n)
        max_pts = 4000
        if n > max_pts:
            step = n // max_pts
            m = n // step * step
            seg = self.data[:m].reshape(-1, step, self.data.shape[1])
            env_lo = seg.min(axis=(1, 2))
            env_hi = seg.max(axis=(1, 2))
            te = np.linspace(0, dur, len(env_lo))
            ax.fill_between(te, env_lo, env_hi, linewidth=0, color="#4a90d9")
        else:
            for ch in range(self.data.shape[1]):
                ax.plot(t, self.data[:, ch], linewidth=0.4)
        self.playhead = ax.axvline(0, color="#e67e22", linewidth=1)
        self.loop_span = None
        ax.set_xlim(0, dur)
        ax.set_ylim(-1.05, 1.05)
        ax.set_xlabel("时间 (s)  —  单击定位, 拖动选择循环区间")
        ax.set_ylabel("幅度")
        self.wave_canvas.draw_idle()

    def _draw_loop_region(self):
        if self.loop_span is not None:
            try:
                self.loop_span.remove()
            except Exception:
                pass
            self.loop_span = None
        if self._loop_region and self.loop_check.isChecked():
            self.loop_span = self.wave_ax.axvspan(*self._loop_region, color="#2ecc71", alpha=0.25)
        self.wave_canvas.draw_idle()

    def _wave_press(self, ev):
        if ev.inaxes is self.wave_ax and ev.xdata is not None:
            self._press_x = ev.xdata

    def _wave_release(self, ev):
        if self._press_x is None or ev.xdata is None or self.data is None:
            self._press_x = None
            return
        x0, x1 = self._press_x, ev.xdata
        self._press_x = None
        dur = len(self.data) / self.sr
        x0 = min(max(x0, 0), dur)
        x1 = min(max(x1, 0), dur)
        if abs(x1 - x0) < 0.02:
            self.player.seek(x1)
        else:
            self._loop_region = (min(x0, x1), max(x0, x1))
            self.loop_check.setChecked(True)
            self.player.set_loop(*self._loop_region)
            self._draw_loop_region()

    # ---- 频响 ----
    def update_freq_response(self):
        if self.params is None or self.sr == 0:
            return
        ax = self.fr_ax
        ax.clear()
        fmax = max_freq(self.sr)
        freqs = np.logspace(math.log10(MIN_FREQ), math.log10(fmax), 500)
        p = self.params
        if not p.bypass:
            if p.low.enabled:
                ax.semilogx(freqs, band_response_db("lowshelf", p.low, self.sr, freqs),
                            color="#3498db", linewidth=1, label="低架")
            if p.mid.enabled:
                ax.semilogx(freqs, band_response_db("peaking", p.mid, self.sr, freqs),
                            color="#2ecc71", linewidth=1, label="峰值")
            if p.high.enabled:
                ax.semilogx(freqs, band_response_db("highshelf", p.high, self.sr, freqs),
                            color="#9b59b6", linewidth=1, label="高架")
        total = freq_response_db(p, self.sr, freqs)
        ax.semilogx(freqs, total, color="#e74c3c", linewidth=2,
                    label="总响应 (含总增益)" + ("  [旁路中]" if p.bypass else ""))
        ax.axhline(0, color="gray", linewidth=0.5, alpha=0.6)
        ax.set_xlim(MIN_FREQ, fmax)
        ax.set_ylim(-MAX_GAIN_DB - 6, MAX_GAIN_DB + 6)
        ax.set_xticks([20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000])
        ax.set_xticklabels(["20", "50", "100", "200", "500", "1k", "2k", "5k", "10k", "20k"])
        ax.grid(True, which="both", alpha=0.25)
        ax.set_xlabel("频率 (Hz, 对数)")
        ax.set_ylabel("增益 (dB)")
        ax.legend(loc="lower right", fontsize=8)
        self.fr_canvas.draw_idle()

    # ---- 定时刷新 ----
    def _tick(self):
        if self.data is None:
            return
        pos = self.player.position()
        dur = len(self.data) / self.sr
        self.time_label.setText(f"{pos:05.1f}s / {dur:05.1f}s")
        if hasattr(self, "playhead"):
            self.playhead.set_xdata([pos, pos])
            self.wave_canvas.draw_idle()
        if not self.player.playing and self.btn_play.text() == "暂停":
            self.btn_play.setText("播放")
        peak = self.player.peak
        self.peak_label.setText(f"峰值: {db_str(peak)}")
        self.clip_label.setVisible(self.player.clipped)

    def _reset_peak(self):
        self.player.reset_peak()

    # ---- 导出 ----
    def export_wav(self):
        if self.data is None or self.params is None:
            return
        path, _ = QFileDialog.getSaveFileName(self, "导出 WAV", "eq_output.wav", "WAV 文件 (*.wav)")
        if not path:
            return
        params = self.params
        out = process_offline(self.data, params, self.sr)
        peak = float(np.max(np.abs(out))) if out.size else 0.0
        if peak > 1.0:
            box = QMessageBox(self)
            box.setWindowTitle("输出超幅")
            box.setText(f"按当前设置导出峰值将达 {db_str(peak)}, 超过 0 dBFS。")
            btn_lower = box.addButton("降低总增益后导出", QMessageBox.AcceptRole)
            btn_anyway = box.addButton("仍按当前设置导出 (会削波)", QMessageBox.DestructiveRole)
            box.addButton(QMessageBox.Cancel)
            box.exec()
            clicked = box.clickedButton()
            if clicked is btn_lower:
                reduce_db = 20 * math.log10(peak) + 0.1
                new_gain = params.master_gain_db - reduce_db
                if new_gain < -MAX_GAIN_DB:
                    QMessageBox.warning(self, "增益不足",
                                        f"需要 {reduce_db:.1f} dB 余量, 总增益下限 -{MAX_GAIN_DB:.0f} dB 仍不够, 已取消。")
                    return
                self.master_spin.setValue(new_gain)  # 触发参数更新, 试听与导出保持一致
                params = self.collect_params()
                out = process_offline(self.data, params, self.sr)
            elif clicked is not btn_anyway:
                return
        pcm = np.clip(out, -1.0, 1.0)
        wavfile.write(path, self.sr, (pcm * 32767.0).astype(np.int16))
        final_peak = float(np.max(np.abs(pcm))) if pcm.size else 0.0
        QMessageBox.information(self, "导出完成",
                                f"已导出: {path}\n最终峰值: {db_str(final_peak)}")

    def closeEvent(self, ev):
        self.player.close()
        super().closeEvent(ev)


def main():
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
