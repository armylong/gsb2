"""Crossover Lab - offline debug tool for two-way crossover split/recombine.

GUI:   python app.py
Selftest (no GUI, writes wavs to a temp dir and validates):
       python app.py --selftest
"""
from __future__ import annotations

import argparse
import os
import sys
import tempfile

import numpy as np
from scipy.io import wavfile

import dsp

GEN_KINDS = [("sweep", "对数扫频 20Hz-20kHz"),
             ("impulse", "脉冲"),
             ("dual", "双音 220Hz + 3kHz"),
             ("noise", "带限噪声")]


# ------------------------------------------------------------------ selftest
def selftest():
    outdir = tempfile.mkdtemp(prefix="xover_selftest_")
    all_ok = True
    for mode, kwargs in [("LR4", {}),
                         ("FIR", {"numtaps": 1025, "compensate": True})]:
        src, sr = dsp.generate("sweep", dur=2.0)
        fc = 1000.0
        low, high, info = dsp.split(src, fc, sr, mode=mode, **kwargs)
        total = dsp.recombine(low, high)
        paths = {}
        for name, sig in [("low", low), ("high", high), ("sum", total)]:
            p = os.path.join(outdir, f"{mode.lower()}_{name}.wav")
            wavfile.write(p, sr, sig.astype(np.float32))
            paths[name] = p
        ok, report = dsp.validate(src, low, high, total, sr, fc)
        all_ok = all_ok and ok
        print(f"=== mode={mode} fc={fc}Hz -> {outdir} ===")
        print(report)
        print()
    print("SELFTEST", "PASS" if all_ok else "FAIL")
    return 0 if all_ok else 1


# ------------------------------------------------------------------ GUI
def run_gui():
    from PySide6.QtCore import Qt, QUrl
    from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
    from PySide6.QtWidgets import (
        QApplication, QCheckBox, QComboBox, QDoubleSpinBox, QFileDialog,
        QGridLayout, QGroupBox, QHBoxLayout, QLabel, QMainWindow, QMessageBox,
        QPushButton, QSpinBox, QVBoxLayout, QWidget)
    import pyqtgraph as pg

    pg.setConfigOptions(antialias=True, background="k", foreground="w")

    class Main(QMainWindow):
        def __init__(self):
            super().__init__()
            self.setWindowTitle("Crossover Lab - 分频/重合成调试")
            self.src = None
            self.sr = dsp.SR_DEFAULT
            self.low = self.high = self.total = None
            self._tmpdir = tempfile.mkdtemp(prefix="xover_play_")
            self._play_sig = None

            self.player = QMediaPlayer(self)
            self.audio = QAudioOutput(self)
            self.player.setAudioOutput(self.audio)
            self.player.positionChanged.connect(self._on_position)

            self._build_ui()
            self._load_generated("sweep")

        # ---------------- UI ----------------
        def _build_ui(self):
            root = QWidget(); self.setCentralWidget(root)
            lay = QHBoxLayout(root)

            ctrl = QVBoxLayout(); lay.addLayout(ctrl, 0)

            gb_src = QGroupBox("信号源"); g = QGridLayout(gb_src)
            self.cmb_gen = QComboBox()
            for k, label in GEN_KINDS:
                self.cmb_gen.addItem(label, k)
            btn_gen = QPushButton("生成样例")
            btn_gen.clicked.connect(lambda: self._load_generated(self.cmb_gen.currentData()))
            btn_open = QPushButton("载入 WAV…")
            btn_open.clicked.connect(self._open_wav)
            g.addWidget(self.cmb_gen, 0, 0); g.addWidget(btn_gen, 0, 1)
            g.addWidget(btn_open, 1, 0, 1, 2)
            ctrl.addWidget(gb_src)

            gb_x = QGroupBox("分频"); g = QGridLayout(gb_x)
            g.addWidget(QLabel("分频点 Hz"), 0, 0)
            self.sp_fc = QDoubleSpinBox(); self.sp_fc.setRange(50, 12000)
            self.sp_fc.setValue(1000); self.sp_fc.setSingleStep(50)
            g.addWidget(self.sp_fc, 0, 1)
            g.addWidget(QLabel("滤波方式"), 1, 0)
            self.cmb_mode = QComboBox()
            self.cmb_mode.addItem("LR4 (IIR, 相位匹配)", "LR4")
            self.cmb_mode.addItem("FIR 线性相位", "FIR")
            g.addWidget(self.cmb_mode, 1, 1)
            g.addWidget(QLabel("FIR 阶数"), 2, 0)
            self.sp_taps = QSpinBox(); self.sp_taps.setRange(65, 4097)
            self.sp_taps.setSingleStep(2); self.sp_taps.setValue(1025)
            g.addWidget(self.sp_taps, 2, 1)
            self.chk_comp = QCheckBox("延迟补偿 (对齐低通)")
            self.chk_comp.setChecked(True)
            g.addWidget(self.chk_comp, 3, 0, 1, 2)
            self.lbl_delay = QLabel("补偿延迟: -")
            g.addWidget(self.lbl_delay, 4, 0, 1, 2)
            self.chk_inv_lo = QCheckBox("低频支路反极性")
            self.chk_inv_hi = QCheckBox("高频支路反极性")
            g.addWidget(self.chk_inv_lo, 5, 0, 1, 2)
            g.addWidget(self.chk_inv_hi, 6, 0, 1, 2)
            ctrl.addWidget(gb_x)

            gb_play = QGroupBox("试听 (同一播放位置)"); g = QGridLayout(gb_play)
            self.play_btns = {}
            for i, (key, label) in enumerate([("src", "源"), ("low", "低频"),
                                              ("high", "高频"), ("sum", "合成")]):
                b = QPushButton(f"▶ {label}")
                b.clicked.connect(lambda _=False, k=key: self._play(k))
                g.addWidget(b, 0, i); self.play_btns[key] = b
            btn_stop = QPushButton("■ 停止")
            btn_stop.clicked.connect(self.player.stop)
            g.addWidget(btn_stop, 1, 0, 1, 4)
            ctrl.addWidget(gb_play)

            gb_wave = QGroupBox("波形显示"); g = QHBoxLayout(gb_wave)
            self.wave_chks = {}
            for key, label in [("src", "源"), ("low", "低"), ("high", "高"), ("sum", "合")]:
                c = QCheckBox(label); c.setChecked(True)
                c.toggled.connect(self._update_plots)
                g.addWidget(c); self.wave_chks[key] = c
            ctrl.addWidget(gb_wave)

            btn_export = QPushButton("导出分轨 + 重合成并验证…")
            btn_export.clicked.connect(self._export)
            ctrl.addWidget(btn_export)
            ctrl.addStretch(1)

            plots = QVBoxLayout(); lay.addLayout(plots, 1)
            self.pw_wave = pg.PlotWidget(title="波形 (竖线=播放位置)")
            self.pw_wave.showGrid(x=True, y=True, alpha=0.3)
            self.pw_wave.setLabel("bottom", "时间", units="s")
            self.playhead = pg.InfiniteLine(pos=0, angle=90, pen=pg.mkPen("y", width=2))
            self.pw_wave.addItem(self.playhead)
            self.pw_mag = pg.PlotWidget(title="频响 (红×=合成超峰)")
            self.pw_mag.showGrid(x=True, y=True, alpha=0.3)
            self.pw_mag.setLogMode(x=True, y=False)
            self.pw_mag.setLabel("bottom", "频率", units="Hz")
            self.pw_mag.setLabel("left", "幅值", units="dB")
            self.pw_mag.setYRange(-60, 15)
            self.pw_mag.addLegend(offset=(10, 10))
            self.pw_ph = pg.PlotWidget(title="相位 / 合成群延迟")
            self.pw_ph.showGrid(x=True, y=True, alpha=0.3)
            self.pw_ph.setLogMode(x=True, y=False)
            self.pw_ph.setLabel("bottom", "频率", units="Hz")
            self.pw_ph.setLabel("left", "相位", units="°")
            self.pw_ph.addLegend(offset=(10, 10))
            plots.addWidget(self.pw_wave, 2)
            plots.addWidget(self.pw_mag, 2)
            plots.addWidget(self.pw_ph, 2)

            for w in (self.sp_fc, self.sp_taps):
                w.valueChanged.connect(self._recompute)
            self.cmb_mode.currentIndexChanged.connect(self._recompute)
            for c in (self.chk_comp, self.chk_inv_lo, self.chk_inv_hi):
                c.toggled.connect(self._recompute)

            self.resize(1200, 800)

        # ---------------- data ----------------
        def _load_generated(self, kind):
            self.src, self.sr = dsp.generate(kind, dur=2.0)
            self._recompute()

        def _open_wav(self):
            path, _ = QFileDialog.getOpenFileName(self, "载入 WAV", "", "WAV (*.wav)")
            if not path:
                return
            sr, data = wavfile.read(path)
            if data.ndim > 1:
                data = data.mean(axis=1)
            data = data.astype(np.float64)
            peak = np.max(np.abs(data)) or 1.0
            if data.dtype != np.float64 or peak > 1.5:
                data = data / max(peak, 1.0)
            n = min(len(data), 10 * sr)          # keep it short
            self.src, self.sr = data[:n], sr
            self.sp_fc.setMaximum(self.sr / 2 * 0.45)
            self._recompute()

        def _params(self):
            return dict(fc=self.sp_fc.value(), mode=self.cmb_mode.currentData(),
                        numtaps=self.sp_taps.value() | 1,
                        compensate=self.chk_comp.isChecked())

        def _recompute(self):
            if self.src is None:
                return
            p = self._params()
            low, high, info = dsp.split(self.src, p["fc"], self.sr, p["mode"],
                                        p["numtaps"], p["compensate"])
            self.low, self.high = dsp.apply_polarity(
                low, high, self.chk_inv_lo.isChecked(), self.chk_inv_hi.isChecked())
            self.total = dsp.recombine(self.low, self.high)
            if p["mode"] == "FIR":
                gd = info["fir_group_delay_samples"]
                self.lbl_delay.setText(
                    f"FIR 群延迟 {gd:.0f} 样点 ({info['fir_group_delay_ms']:.2f} ms); "
                    f"{'已补偿' if p['compensate'] else '未补偿!'}")
            else:
                self.lbl_delay.setText("LR4: 低/高通相位匹配, 无需补偿延迟")
            self._update_plots()

        # ---------------- plots ----------------
        def _update_plots(self):
            if self.src is None:
                return
            sr = self.sr
            t = np.arange(len(self.src)) / sr
            self.pw_wave.clear()
            self.pw_wave.addItem(self.playhead)
            series = [("src", self.src, "w"), ("low", self.low, "c"),
                      ("high", self.high, "m"), ("sum", self.total, "g")]
            step = max(1, len(t) // 4000)
            for key, sig, color in series:
                if self.wave_chks[key].isChecked():
                    self.pw_wave.plot(t[::step], sig[::step],
                                     pen=pg.mkPen(color, width=1))
            # time-domain overshoot markers on the sum
            ref = np.max(np.abs(self.src))
            over = np.where(np.abs(self.total) > max(ref * 1.001, 1.0))[0]
            if len(over):
                self.pw_wave.plot(t[over], self.total[over], pen=None,
                                 symbol="o", symbolSize=5, symbolBrush="r")

            p = self._params()
            r = dsp.responses(p["fc"], sr, p["mode"], p["numtaps"],
                              p["compensate"], self.chk_inv_lo.isChecked(),
                              self.chk_inv_hi.isChecked())
            f = r["freqs"]
            fx = np.log10(f)
            self.pw_mag.clear()
            self.pw_mag.plot(fx, dsp.db(r["H_low"]), pen=pg.mkPen("c", width=2), name="低通")
            self.pw_mag.plot(fx, dsp.db(r["H_high"]), pen=pg.mkPen("m", width=2), name="高通")
            sum_db = dsp.db(r["H_sum"])
            self.pw_mag.plot(fx, sum_db, pen=pg.mkPen("g", width=2), name="合成")
            self.pw_mag.addItem(pg.InfiniteLine(pos=np.log10(p["fc"]), angle=90,
                                                pen=pg.mkPen("y", style=Qt.DashLine)))
            peaks = dsp.overshoot_peaks(f, sum_db)
            if peaks:
                self.pw_mag.plot(fx[peaks], sum_db[peaks], pen=None, symbol="x",
                                 symbolSize=12, symbolPen=pg.mkPen("r", width=2),
                                 name="超峰")
                i = peaks[int(np.argmax(sum_db[peaks]))]
                self.pw_mag.setTitle(
                    f"频响 (红×=合成超峰, 最大 {sum_db[i]:+.2f} dB @ {f[i]:.0f} Hz)")
            else:
                self.pw_mag.setTitle("频响 (合成无超峰)")

            self.pw_ph.clear()
            self.pw_ph.plot(fx, np.unwrap(np.angle(r["H_low"])) * 180 / np.pi,
                            pen=pg.mkPen("c"), name="低通相位")
            self.pw_ph.plot(fx, np.unwrap(np.angle(r["H_high"])) * 180 / np.pi,
                            pen=pg.mkPen("m"), name="高通相位")
            self.pw_ph.plot(fx, np.unwrap(np.angle(r["H_sum"])) * 180 / np.pi,
                            pen=pg.mkPen("g", width=2), name="合成相位")
            gd = dsp.group_delay_ms(r["H_sum"], f, sr)
            self.pw_ph.setTitle(
                f"相位 / 合成群延迟 @{p['fc']:.0f}Hz ≈ "
                f"{np.interp(p['fc'], f, gd):.2f} ms; "
                f"补偿延迟 {r['comp_delay_samples']:.0f} 样点 "
                f"({r['comp_delay_ms']:.2f} ms)")

        # ---------------- playback ----------------
        def _play(self, key):
            sig = {"src": self.src, "low": self.low,
                   "high": self.high, "sum": self.total}[key]
            if sig is None:
                return
            pos = self.player.position()          # keep same play position
            pcm = np.clip(sig, -1, 1)
            path = os.path.join(self._tmpdir, f"play_{key}.wav")
            wavfile.write(path, self.sr, (pcm * 32767).astype(np.int16))
            self.player.setSource(QUrl.fromLocalFile(path))
            if self.player.playbackState() == QMediaPlayer.PlayingState and pos > 0:
                self.player.play()
                self.player.setPosition(pos)
            else:
                self.player.play()

        def _on_position(self, ms):
            self.playhead.setValue(ms / 1000.0)

        # ---------------- export ----------------
        def _export(self):
            if self.src is None:
                return
            outdir = QFileDialog.getExistingDirectory(self, "选择导出目录")
            if not outdir:
                return
            for name, sig in [("low", self.low), ("high", self.high),
                              ("sum", self.total)]:
                wavfile.write(os.path.join(outdir, f"{name}.wav"),
                              self.sr, sig.astype(np.float32))
            ok, report = dsp.validate(self.src, self.low, self.high,
                                      self.total, self.sr, self.sp_fc.value())
            QMessageBox.information(
                self, "导出验证 " + ("通过" if ok else "失败"),
                f"已导出 low.wav / high.wav / sum.wav 到:\n{outdir}\n\n{report}")

    app = QApplication(sys.argv)
    w = Main()
    w.show()
    return app.exec()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true",
                    help="run headless validation and exit")
    args = ap.parse_args()
    sys.exit(selftest() if args.selftest else run_gui())
