"""PySide6 图形界面: 立体声复合信号(MPX)编码/解码实验台。

界面只播放和导出"解码输出", 原始左右声道仅以虚线参考迹线出现用于比对位置。
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QFileDialog, QFormLayout, QGroupBox,
    QHBoxLayout, QLabel, QMainWindow, QMessageBox, QPlainTextEdit, QPushButton,
    QRadioButton, QSlider, QSplitter, QVBoxLayout, QWidget,
)
from PySide6.QtCore import QUrl

from . import dsp

COL_L = "#4C9BE8"      # 解码左声道
COL_R = "#E8704C"      # 解码右声道
COL_MONO = "#8E8E93"   # 单声道
COL_REF = "#B0B0B0"    # 输入参考(虚线)
COL_PILOT = "#F2C94C"
COL_EDGE = "#3A3A3C"

SPECTRUM_VIEWS = [
    ("复合信号全谱 0–96 kHz", "mpx"),
    ("和支路 S 低通后 (0–24 kHz 视图)", "sum"),
    ("差支路 D 相干解调后 (0–24 kHz 视图)", "diff"),
    ("导频带通输出 (18–20 kHz 视图)", "pilot"),
    ("解码单声道 mono (0–24 kHz 视图)", "mono"),
    ("解码左声道 L (0–24 kHz 视图)", "left"),
    ("解码右声道 R (0–24 kHz 视图)", "right"),
]


def _fmt_db(v: float) -> str:
    return f"{v:6.1f} dB"


class SpectrumView(QWidget):
    """自绘功率谱: 固定纵轴 -100..0 dB, 横轴按信号采样率标 kHz。"""

    def __init__(self):
        super().__init__()
        self.setMinimumHeight(260)
        self._f: np.ndarray | None = None
        self._psd: np.ndarray | None = None
        self._fmax = dsp.MPX_FS / 2
        self._markers: list[tuple[float, str]] = []
        self._title = ""

    def set_data(self, x: np.ndarray, fs: float, title: str,
                 markers: list[tuple[float, str]] | None = None,
                 fmax: float | None = None):
        self._f, self._psd = dsp.spectrum_db(x, fs)
        self._title = title
        self._markers = markers or []
        self._fmax = fmax or fs / 2
        self.update()

    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        w, h = self.width(), self.height()
        ml, mr, mt, mb = 58, 14, 26, 26
        pw, ph = w - ml - mr, h - mt - mb
        p.fillRect(self.rect(), Qt.black)
        p.setPen(QPen(Qt.darkGray, 1))
        p.drawRect(ml, mt, pw, ph)

        def X(freq):
            return ml + pw * min(freq / self._fmax, 1.0)

        def Y(db):
            return mt + ph * (1 - (np.clip(db, -100, 0) + 100) / 100.0)

        # 网格与刻度
        p.setPen(QPen(QColor("#2A2A2C"), 1))
        for db in range(-100, 1, 10):
            y = Y(db)
            p.drawLine(ml, int(y), ml + pw, int(y))
            p.setPen(QColor("#9A9AA0"))
            p.drawText(4, int(y) + 4, f"{db}")
            p.setPen(QColor("#2A2A2C"))
        step = 10_000 if self._fmax > 30_000 else 4_000
        f = 0.0
        while f <= self._fmax:
            x = X(f)
            p.drawLine(int(x), mt, int(x), mt + ph)
            p.setPen(QColor("#9A9AA0"))
            p.drawText(int(x) - 14, mt + ph + 8, f"{f/1000:.0f}k")
            p.setPen(QColor("#2A2A2C"))
            f += step

        if self._f is None:
            p.end()
            return

        # 标记频段(导频 18.5–19.5k、差信号 23–53k 等)
        for freq, label in self._markers:
            x = X(freq)
            p.setPen(QPen(QColor(COL_PILOT), 1, Qt.DashLine))
            p.drawLine(int(x), mt, int(x), mt + ph)
            p.setPen(QColor(COL_PILOT))
            p.drawText(int(x) + 3, mt + 12, label)

        # 谱线
        mask = self._f <= self._fmax
        ff, dd = self._f[mask], self._psd[mask]
        p.setPen(QPen(QColor("#5AC8FA"), 1.5))
        prev = None
        for freq, db in zip(ff, dd):
            pt = (int(X(freq)), int(Y(db)))
            if prev is not None:
                p.drawLine(prev[0], prev[1], pt[0], pt[1])
            prev = pt

        # 峰值读数
        i = int(np.argmax(dd))
        p.setPen(QColor("#E6E6E8"))
        p.drawText(ml + 8, mt + 16,
                   f"{self._title}    峰值 {ff[i]/1000:.2f} kHz / {dd[i]:.1f} dB")
        p.end()


class WaveformView(QWidget):
    """自绘波形: 多迹线叠加, 阴影标出首尾滤波瞬态区, 验证同位置脉冲同步。"""

    def __init__(self):
        super().__init__()
        self.setMinimumHeight(220)
        self._traces: list[tuple[np.ndarray, str, str, Qt.PenStyle]] = []
        self._fs = dsp.AUDIO_FS
        self._margin = dsp.EDGE_MARGIN

    def set_traces(self, traces, fs: int = dsp.AUDIO_FS, margin: int = dsp.EDGE_MARGIN):
        self._traces = traces
        self._fs = fs
        self._margin = margin
        self.update()

    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        w, h = self.width(), self.height()
        ml, mr, mt, mb = 58, 14, 12, 24
        pw, ph = w - ml - mr, h - mt - mb
        p.fillRect(self.rect(), Qt.black)
        mid = mt + ph / 2
        p.setPen(QPen(Qt.darkGray, 1))
        p.drawRect(ml, mt, pw, ph)
        for g in (-1, -0.5, 0, 0.5, 1):
            y = int(mid - g * ph / 2.2)
            p.setPen(QColor("#2A2A2C"))
            p.drawLine(ml, y, ml + pw, y)
            p.setPen(QColor("#9A9AA0"))
            p.drawText(6, y + 4, f"{g:.1f}")

        if not self._traces:
            p.end()
            return
        n = max(len(t[0]) for t in self._traces)

        def X(i):
            return ml + pw * i / max(n - 1, 1)

        # 首尾瞬态阴影(该区间不参与指标计算)
        for idx in (self._margin, n - self._margin):
            x = X(idx)
            p.fillRect(int(x), mt, max(int(X(idx + 1) - x), 1), ph, QColor(COL_EDGE))
        p.setPen(QColor("#777"))
        p.drawText(int(X(self._margin)) + 2, mt + 12, "滤波瞬态区(指标剔除)")
        p.drawText(int(X(n - self._margin)) - 110, mt + 12, "滤波瞬态区(指标剔除)")

        # 逐桶取 min/max 画上下包络, 连续正弦也不会糊成实心块
        target = min(n, 1600)
        step = max(1, n // target)

        def Yof(v):
            return mid - np.clip(v, -1.1, 1.1) * ph / 2.2

        for y, color, _label, style in self._traces:
            p.setPen(QPen(QColor(color), 1.2, style))
            nb = len(y) // step
            for b in range(nb):
                chunk = y[b * step:(b + 1) * step]
                x0, x1 = int(X(b * step)), int(X(min((b + 1) * step, len(y) - 1)))
                p.drawLine(x0, int(Yof(float(np.min(chunk)))),
                           x0, int(Yof(float(np.max(chunk)))))
                p.drawLine(x0, int(Yof(float(np.max(chunk)))),
                           x1, int(Yof(float(np.max(chunk)))))
                p.drawLine(x0, int(Yof(float(np.min(chunk)))),
                           x1, int(Yof(float(np.min(chunk)))))

        # 图例
        lx = ml + 10
        p.setPen(QColor("#E6E6E8"))
        for _y, color, label, style in self._traces:
            p.setPen(QPen(QColor(color), 2, style))
            p.drawLine(lx, mt + ph - 8, lx + 22, mt + ph - 8)
            p.setPen(QColor("#E6E6E8"))
            p.drawText(lx + 26, mt + ph - 4, label)
            lx += 26 + p.fontMetrics().horizontalAdvance(label) + 22
        p.setPen(QColor("#9A9AA0"))
        p.drawText(ml, h - 6, f"时间轴 0–{n/self._fs:.2f} s (fs={self._fs} Hz)")
        p.end()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("立体声复合信号(MPX)实验台 —— 纯计算机内, 无发射设备")
        self.resize(1280, 860)

        self.rng = np.random.default_rng()
        self.input_left = self.input_right = None
        self.input_fs = dsp.AUDIO_FS
        self.mpx = None
        self.dec: dsp.DecodeResult | None = None
        self._tmpdir = tempfile.mkdtemp(prefix="mpx_play_")
        self._players: list[QMediaPlayer] = []

        self._build_ui()
        self._rebuild_input()

    # ------------------------------------------------------------ UI 搭建
    def _build_ui(self):
        root = QSplitter(Qt.Horizontal)
        left = QWidget()
        lv = QVBoxLayout(left)

        g1 = QGroupBox("① 输入信号")
        f1 = QFormLayout(g1)
        self.kind = QComboBox()
        for k in dsp.TEST_KINDS:
            self.kind.addItem(dsp.TEST_LABELS[k], k)
        self.kind.currentIndexChanged.connect(self._rebuild_input)
        f1.addRow("测试音:", self.kind)
        self.dur = QComboBox()
        for d in (1.0, 2.0, 4.0):
            self.dur.addItem(f"{d:.0f} 秒", d)
        self.dur.currentIndexChanged.connect(self._rebuild_input)
        f1.addRow("时长:", self.dur)
        btn_wav = QPushButton("改用外部立体声 WAV…")
        btn_wav.clicked.connect(self._pick_wav)
        f1.addRow(btn_wav)
        self.lbl_input = QLabel()
        self.lbl_input.setWordWrap(True)
        f1.addRow(self.lbl_input)
        lv.addWidget(g1)

        g2 = QGroupBox("② 编码(写入一条 192 kHz 复合数字信号)")
        f2 = QFormLayout(g2)
        self.chk_pilot = QCheckBox("加入 19 kHz 导频(固定音)")
        self.chk_pilot.setChecked(True)
        self.chk_pilot.stateChanged.connect(self._rebuild_input)
        f2.addRow(self.chk_pilot)
        self.lbl_mpx = QLabel()
        self.lbl_mpx.setWordWrap(True)
        f2.addRow(self.lbl_mpx)
        lv.addWidget(g2)

        g3 = QGroupBox("③ 解码通道损伤(只作用于复合信号)")
        f3 = QFormLayout(g3)
        self.noise = QSlider(Qt.Horizontal)
        self.noise.setRange(-40, 25)        # dB 相对复合 RMS, 40 档代表"无噪声"由 -40 近似
        self.noise.setValue(-40)
        self.noise.valueChanged.connect(self._redecode)
        self.lbl_noise = QLabel()
        f3.addRow("加性白噪声 dB:", self.noise)
        f3.addRow("", self.lbl_noise)
        self.phase = QSlider(Qt.Horizontal)
        self.phase.setRange(-180, 180)
        self.phase.setValue(0)
        self.phase.valueChanged.connect(self._redecode)
        self.lbl_phase = QLabel()
        f3.addRow("副载波固定相偏 °:", self.phase)
        f3.addRow("", self.lbl_phase)
        self.force_mono = QCheckBox("强制单声道解码(只读 0–15 kHz 和信号)")
        self.force_mono.stateChanged.connect(self._redecode)
        f3.addRow(self.force_mono)
        lv.addWidget(g3)

        g4 = QGroupBox("④ 导频与重建指标")
        f4 = QFormLayout(g4)
        self.lbl_lock = QLabel()
        self.lbl_lock.setWordWrap(True)
        f4.addRow("导频状态:", self.lbl_lock)
        self.lbl_metrics = QLabel()
        self.lbl_metrics.setWordWrap(True)
        f4.addRow(self.lbl_metrics)
        lv.addWidget(g4)

        g5 = QGroupBox("⑤ 播放与导出(仅解码输出, 不播输入)")
        bv = QVBoxLayout(g5)
        row = QHBoxLayout()
        self.play_choice = QComboBox()
        self.play_choice.addItems(["立体声 L/R", "单声道 mono"])
        row.addWidget(self.play_choice)
        btn_play = QPushButton("播放")
        btn_play.clicked.connect(self._play)
        btn_stop = QPushButton("停止")
        btn_stop.clicked.connect(self._stop_play)
        row.addWidget(btn_play)
        row.addWidget(btn_stop)
        bv.addLayout(row)
        row2 = QHBoxLayout()
        btn_exp_s = QPushButton("导出立体声 WAV")
        btn_exp_s.clicked.connect(lambda: self._export(False))
        btn_exp_m = QPushButton("导出单声道 WAV")
        btn_exp_m.clicked.connect(lambda: self._export(True))
        row2.addWidget(btn_exp_s)
        row2.addWidget(btn_exp_m)
        bv.addLayout(row2)
        lv.addWidget(g5)

        lv.addStretch(1)
        root.addWidget(left)

        # 右侧: 频谱 / 波形 / 消息
        right = QSplitter(Qt.Vertical)
        spec_box = QWidget()
        sv = QVBoxLayout(spec_box)
        srow = QHBoxLayout()
        srow.addWidget(QLabel("频谱读数:"))
        self.spec_pick = QComboBox()
        for label, key in SPECTRUM_VIEWS:
            self.spec_pick.addItem(label, key)
        self.spec_pick.currentIndexChanged.connect(self._refresh_spectrum)
        srow.addWidget(self.spec_pick, stretch=1)
        sv.addLayout(srow)
        self.spec = SpectrumView()
        sv.addWidget(self.spec)
        right.addWidget(spec_box)

        wave_box = QWidget()
        wv = QVBoxLayout(wave_box)
        wrow = QHBoxLayout()
        wrow.addWidget(QLabel("波形(虚线=输入参考, 只用于核对位置):"))
        self.chk_ref = QCheckBox("显示输入参考迹线")
        self.chk_ref.setChecked(True)
        self.chk_ref.stateChanged.connect(self._refresh_waveform)
        self.chk_mono = QCheckBox("叠加 mono")
        self.chk_mono.stateChanged.connect(self._refresh_waveform)
        wrow.addWidget(self.chk_ref)
        wrow.addWidget(self.chk_mono)
        wv.addLayout(wrow)
        self.wave = WaveformView()
        wv.addWidget(self.wave)
        right.addWidget(wave_box)

        self.messages = QPlainTextEdit()
        self.messages.setReadOnly(True)
        self.messages.setPlaceholderText("解码消息 / 退回行为提示")
        right.addWidget(self.messages)
        right.setSizes([320, 300, 150])
        root.addWidget(right)
        root.setSizes([360, 900])
        self.setCentralWidget(root)

    # ------------------------------------------------------------ 数据流
    def _rebuild_input(self):
        kind = self.kind.currentData()
        dur = self.dur.currentData()
        self.input_left, self.input_right, self.input_fs = dsp.make_test_signal(
            kind, duration=dur
        )
        self.lbl_input.setText(
            f"{self.kind.currentText()}\n{len(self.input_left)} 样本 @ {self.input_fs} Hz"
        )
        self._encode()

    def _pick_wav(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择立体声 WAV(在独立目录中, 只读)", "", "WAV (*.wav)"
        )
        if not path:
            return
        try:
            l, r, fs = dsp.load_wav(path)
        except Exception as e:  # 外部文件不可信, 失败只提示不崩
            QMessageBox.warning(self, "读取失败", f"{path}\n{e}")
            return
        self.input_left, self.input_right, self.input_fs = l, r, fs
        self.lbl_input.setText(
            f"{Path(path).name}\n{len(l)} 样本, 重采样到 {fs} Hz"
        )
        self._encode()

    def _encode(self):
        self.mpx, _, _ = dsp.encode(
            self.input_left, self.input_right, self.input_fs,
            include_pilot=self.chk_pilot.isChecked(),
        )
        self.lbl_mpx.setText(
            f"复合信号 {len(self.mpx)} 样本 @ {dsp.MPX_FS} Hz\n"
            f"奈奎斯特 {dsp.MPX_FS//2000} kHz | 峰值 {np.max(np.abs(self.mpx)):.3f} | "
            f"RMS {np.sqrt(np.mean(self.mpx**2)):.3f}"
        )
        self._redecode()

    def _redecode(self):
        if self.mpx is None:
            return
        db = self.noise.value()
        self.lbl_noise.setText(f"{db} dB(相对复合信号 RMS)")
        phi = self.phase.value()
        self.lbl_phase.setText(f"{phi:+d}°")
        noisy = dsp.add_noise(self.mpx, float(db), self.rng)
        sigma = float(np.std(noisy - self.mpx))
        self.dec = dsp.decode(
            noisy, len(self.input_left),
            phase_offset_deg=float(phi),
            force_mono=self.force_mono.isChecked(),
            noise_sigma=sigma,
        )
        self._refresh_metrics()
        self._refresh_spectrum()
        self._refresh_waveform()
        self.messages.setPlainText("\n".join(self.dec.messages) or "解码正常, 无特殊提示。")

    # ------------------------------------------------------------ 指标与视图
    def _refresh_metrics(self):
        d = self.dec
        pi = d.pilot
        if d.fallback:
            self.lbl_lock.setText(
                f"⚠ 未使用立体声\n{'强制单声道' if self.force_mono.isChecked() else '导频未锁定'}，"
                "L=R=mono"
            )
            self.lbl_lock.setStyleSheet("color:#FF9F0A; font-weight:600")
        else:
            self.lbl_lock.setText(
                f"● 已锁定 19 kHz 导频\n幅度 {pi.amplitude:.4f} / RMS 比 {pi.rms_ratio:.4f}"
                f"(门限 {dsp.PILOT_LOCK_RATIO})\n谱峰频率 {pi.measured_freq:.1f} Hz，"
                f"初相 {np.rad2deg(pi.phase):+.1f}°"
            )
            self.lbl_lock.setStyleSheet("color:#30D158; font-weight:600")
        m = dsp.EDGE_MARGIN
        balance = dsp.channel_energy_balance(self.input_left, self.input_right, m)
        sep = dsp.crosstalk_db(self.input_left, self.input_right, d.left, d.right, m)
        sep_kind = "主/串声道分离度" if balance >= 20.0 else "双主声道 L−R 差值(越大越一致)"
        snr_l = dsp.reconstruction_snr(self.input_left, d.left, m)
        snr_r = dsp.reconstruction_snr(self.input_right, d.right, m)
        sub_leak = dsp.tone_level(d.mpx, dsp.MPX_FS, dsp.SUBC_F)
        self.lbl_metrics.setText(
            f"输入左右能量比: {balance:.1f} dB\n"
            f"{sep_kind}: {sep:.1f} dB\n"
            f"重建 SNR  L: {snr_l:.1f} dB   R: {snr_r:.1f} dB\n"
            f"复合信号 38 kHz 副载波泄漏: {20*np.log10(sub_leak+1e-20):.1f} dB\n"
            f"补偿群延迟: {dsp.DELAY_AUDIO} 音频样本 "
            f"({dsp.DELAY_AUDIO/dsp.AUDIO_FS*1000:.2f} ms)\n"
            f"加噪 σ: {d.noise_sigma:.4f}"
        )

    def _refresh_spectrum(self):
        key = self.spec_pick.currentData()
        d = self.dec
        if key == "mpx":
            self.spec.set_data(
                d.mpx, dsp.MPX_FS, "复合信号 MPX",
                markers=[(dsp.PILOT_F, "19k 导频"), (dsp.SUBC_F, "38k 副载波")],
            )
        elif key == "sum":
            self.spec.set_data(d.sum_mpx, dsp.MPX_FS, "和支路 S=(L+R) 低通",
                               fmax=24_000)
        elif key == "diff":
            self.spec.set_data(d.diff_mpx, dsp.MPX_FS, "差支路 D=(L-R) 解调后",
                               fmax=24_000)
        elif key == "pilot":
            self.spec.set_data(d.pilot_mpx, dsp.MPX_FS, "导频带通输出",
                               markers=[(dsp.PILOT_F, "19k")], fmax=24_000)
        elif key == "mono":
            self.spec.set_data(d.mono, dsp.AUDIO_FS, "解码单声道 mono", fmax=24_000)
        elif key == "left":
            self.spec.set_data(d.left, dsp.AUDIO_FS, "解码左声道 L", fmax=24_000)
        else:
            self.spec.set_data(d.right, dsp.AUDIO_FS, "解码右声道 R", fmax=24_000)

    def _refresh_waveform(self):
        d = self.dec
        traces = [
            (d.left, COL_L, "解码 L", Qt.SolidLine),
            (d.right, COL_R, "解码 R", Qt.SolidLine),
        ]
        if self.chk_mono.isChecked():
            traces.append((d.mono, COL_MONO, "mono", Qt.DashDotLine))
        if self.chk_ref.isChecked():
            traces.append((self.input_left, COL_REF, "输入 L 参考", Qt.DashLine))
            traces.append((self.input_right, COL_REF, "输入 R 参考", Qt.DashLine))
        self.wave.set_traces(traces)

    # ------------------------------------------------------------ 播放/导出
    def _write_playback_wav(self, mono: bool) -> str:
        d = self.dec
        path = os.path.join(self._tmpdir, "play_mono.wav" if mono else "play_stereo.wav")
        if mono:
            dsp.save_wav(path, d.mono, None)
        else:
            dsp.save_wav(path, d.left, d.right)
        return path

    def _play(self):
        self._stop_play()
        mono = self.play_choice.currentIndex() == 1
        path = self._write_playback_wav(mono)
        player = QMediaPlayer(self)
        out = QAudioOutput(self)
        player.setAudioOutput(out)
        player.setSource(QUrl.fromLocalFile(path))
        out.setVolume(0.9)
        player.play()
        self._players = [player, out]

    def _stop_play(self):
        for obj in self._players:
            if isinstance(obj, QMediaPlayer):
                obj.stop()
        self._players = []

    def _export(self, mono: bool):
        d = self.dec
        default = "mpx_decoded_mono.wav" if mono else "mpx_decoded_stereo.wav"
        path, _ = QFileDialog.getSaveFileName(self, "导出解码 WAV", default, "WAV (*.wav)")
        if not path:
            return
        try:
            if mono:
                gain = dsp.save_wav(path, d.mono, None)
            else:
                gain = dsp.save_wav(path, d.left, d.right)
        except Exception as e:
            QMessageBox.warning(self, "导出失败", str(e))
            return
        QMessageBox.information(
            self, "已导出",
            f"{path}\n48 kHz 16-bit PCM, 峰值余量增益 {20*np.log10(gain):.1f} dB\n"
            "可用任意外部播放器核对声道归属。",
        )

    def closeEvent(self, e):
        self._stop_play()
        super().closeEvent(e)


def main():
    import sys

    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
