"""PySide6 图形界面:底噪基线分析 + 窄音减弱试听。"""
from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt, QUrl
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
from PySide6.QtWidgets import (
    QApplication, QComboBox, QFileDialog, QHBoxLayout, QLabel, QListWidget,
    QMainWindow, QMessageBox, QPushButton, QPlainTextEdit, QVBoxLayout, QWidget,
)
from PySide6.QtGui import QColor, QPainter, QPen

from . import core

EXAMPLES = [
    ("稳定嗡声(50Hz+谐波)", "stable_hum"),
    ("缓慢漂移底噪", "drifting"),
    ("夹带瞬态的底噪", "transient"),
    ("含嗡声的节目信号(用于减弱演示)", "signal"),
]


# ---------------------------------------------------------------- 波形控件

class WaveformWidget(QWidget):
    """波形显示 + 鼠标拖选区域;绿色块为已登记的无声片段。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(140)
        self.audio: np.ndarray | None = None
        self.sr = core.SR
        self.segments: list[tuple[float, float]] = []
        self.sel: tuple[float, float] | None = None  # 秒
        self._drag_start: float | None = None

    def set_audio(self, x: np.ndarray, sr: int):
        self.audio, self.sr = x, sr
        self.segments, self.sel = [], None
        self.update()

    def _x2t(self, px: float) -> float:
        dur = len(self.audio) / self.sr if self.audio is not None else 1.0
        return max(0.0, min(dur, px / max(1, self.width()) * dur))

    def mousePressEvent(self, e):
        if self.audio is not None:
            self._drag_start = self._x2t(e.position().x())
            self.sel = (self._drag_start, self._drag_start)
            self.update()

    def mouseMoveEvent(self, e):
        if self._drag_start is not None:
            t = self._x2t(e.position().x())
            self.sel = (min(self._drag_start, t), max(self._drag_start, t))
            self.update()

    def mouseReleaseEvent(self, e):
        self._drag_start = None

    def paintEvent(self, _):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(30, 30, 34))
        if self.audio is None or len(self.audio) == 0:
            p.setPen(QColor(160, 160, 160))
            p.drawText(self.rect(), Qt.AlignCenter, "生成示例或载入 WAV 后,在此拖动选择无声片段")
            return
        w, h = self.width(), self.height()
        mid = h / 2
        # 已登记片段
        for a, b in self.segments:
            dur = len(self.audio) / self.sr
            p.fillRect(int(a / dur * w), 0, max(1, int((b - a) / dur * w)), h, QColor(40, 120, 60, 90))
        # 波形(min/max 包络)
        p.setPen(QPen(QColor(90, 200, 250)))
        n = len(self.audio)
        for col in range(w):
            i0, i1 = int(col / w * n), max(int((col + 1) / w * n), int(col / w * n) + 1)
            seg = self.audio[i0:i1]
            lo, hi = float(seg.min()), float(seg.max())
            p.drawLine(col, int(mid - hi * mid * 0.95), col, int(mid - lo * mid * 0.95))
        # 当前选区
        if self.sel:
            dur = len(self.audio) / self.sr
            x0, x1 = int(self.sel[0] / dur * w), int(self.sel[1] / dur * w)
            p.fillRect(x0, 0, max(1, x1 - x0), h, QColor(250, 200, 60, 70))
            p.setPen(QColor(250, 220, 120))
            p.drawText(6, 16, f"选区 {self.sel[0]:.2f}s ~ {self.sel[1]:.2f}s ({self.sel[1]-self.sel[0]:.2f}s)")


# ---------------------------------------------------------------- 频段柱状图

class BandChartWidget(QWidget):
    """倍频程带电平柱状图:柱为中位电平,竖须为片段间波动范围。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(200)
        self.median: list[float] = []
        self.spread: list[float] = []

    def set_data(self, median, spread):
        self.median, self.spread = list(median), list(spread)
        self.update()

    def paintEvent(self, _):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(30, 30, 34))
        if not self.median:
            p.setPen(QColor(160, 160, 160))
            p.drawText(self.rect(), Qt.AlignCenter, "分析后显示分频段电平(柱)与波动(竖须)")
            return
        lo, hi = -100.0, 0.0
        w, h = self.width(), self.height()
        n = len(self.median)
        bw = w / n
        p.setPen(QColor(140, 140, 140))
        for db in range(-100, 1, 20):
            y = int(h * (db - hi) / (lo - hi))
            p.drawLine(0, y, w, y)
            p.drawText(4, y - 2, f"{db}")
        for i, (m, s) in enumerate(zip(self.median, self.spread)):
            x = int(i * bw + bw * 0.2)
            bwid = int(bw * 0.6)
            y_top = int(h * (max(m, lo) - hi) / (lo - hi))
            color = QColor(90, 200, 250) if s < 3 else QColor(250, 170, 60)
            p.fillRect(x, y_top, bwid, h - y_top, color)
            # 波动竖须
            y_lo = int(h * (max(m - s / 2, lo) - hi) / (lo - hi))
            y_hi = int(h * (min(m + s / 2, hi) - hi) / (lo - hi))
            p.setPen(QPen(QColor(255, 90, 90), 2))
            cx = x + bwid // 2
            p.drawLine(cx, y_hi, cx, y_lo)
            p.setPen(QColor(200, 200, 200))
            label = f"{core.BAND_CENTERS[i]:g}"
            p.drawText(int(i * bw), h - 4, label)


# ---------------------------------------------------------------- 主窗口

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("底噪稳定性检查 noise_lab")
        self.resize(960, 720)
        self.audio: np.ndarray | None = None
        self.sr = core.SR
        self.segments: list[tuple[float, float]] = []
        self.baseline: core.BaselineReport | None = None
        self.processed: np.ndarray | None = None
        self.notches: list[float] = []
        self._tmp = Path(tempfile.mkdtemp(prefix="noise_lab_play_"))

        self.player = QMediaPlayer(self)
        self.audio_out = QAudioOutput(self)
        self.player.setAudioOutput(self.audio_out)

        # --- 顶部:音源 ---
        top = QHBoxLayout()
        self.combo = QComboBox()
        for label, _ in EXAMPLES:
            self.combo.addItem(label)
        btn_gen = QPushButton("生成示例")
        btn_gen.clicked.connect(self.on_generate)
        btn_open = QPushButton("载入 WAV…")
        btn_open.clicked.connect(self.on_open)
        self.btn_play = QPushButton("播放原始")
        self.btn_play.clicked.connect(lambda: self.play(self.audio))
        btn_stop = QPushButton("停止")
        btn_stop.clicked.connect(self.player.stop)
        for w in (self.combo, btn_gen, btn_open, self.btn_play, btn_stop):
            top.addWidget(w)

        # --- 波形与选段 ---
        self.wave = WaveformWidget()
        seg_row = QHBoxLayout()
        btn_add = QPushButton("将选区加为无声片段")
        btn_add.clicked.connect(self.on_add_segment)
        btn_clear = QPushButton("清空片段")
        btn_clear.clicked.connect(self.on_clear_segments)
        self.btn_analyze = QPushButton("分析基线")
        self.btn_analyze.clicked.connect(self.on_analyze)
        for w in (btn_add, btn_clear, self.btn_analyze):
            seg_row.addWidget(w)
        self.seg_list = QListWidget()
        self.seg_list.setMaximumHeight(90)

        # --- 结果 ---
        self.chart = BandChartWidget()
        self.result = QPlainTextEdit()
        self.result.setReadOnly(True)
        self.result.setMaximumHeight(180)

        # --- 窄音减弱 ---
        tone_row = QHBoxLayout()
        btn_reduce = QPushButton("估计并减弱稳定窄音")
        btn_reduce.clicked.connect(self.on_reduce)
        self.btn_play_proc = QPushButton("试听处理后")
        self.btn_play_proc.clicked.connect(lambda: self.play(self.processed))
        btn_export_wav = QPushButton("导出处理音轨…")
        btn_export_wav.clicked.connect(self.on_export_wav)
        btn_export_prof = QPushButton("导出测量剖面…")
        btn_export_prof.clicked.connect(self.on_export_profile)
        for w in (btn_reduce, self.btn_play_proc, btn_export_wav, btn_export_prof):
            tone_row.addWidget(w)

        lay = QVBoxLayout()
        lay.addLayout(top)
        lay.addWidget(self.wave)
        lay.addLayout(seg_row)
        lay.addWidget(self.seg_list)
        lay.addWidget(self.chart)
        lay.addWidget(self.result)
        lay.addLayout(tone_row)
        root = QWidget()
        root.setLayout(lay)
        self.setCentralWidget(root)
        self.statusBar().showMessage("就绪:先生成示例或载入 WAV")

    # ------------------------------------------------------------ 音源

    def on_generate(self):
        kind = EXAMPLES[self.combo.currentIndex()][1]
        self.audio = core.generate_example(kind, self.sr)
        self._reset_analysis()
        self.wave.set_audio(self.audio, self.sr)
        self.statusBar().showMessage(f"已生成示例:{self.combo.currentText()}")

    def on_open(self):
        path, _ = QFileDialog.getOpenFileName(self, "载入 WAV", "", "WAV 文件 (*.wav)")
        if not path:
            return
        try:
            self.audio, self.sr = core.read_wav(path)
        except Exception as e:  # noqa: BLE001
            QMessageBox.warning(self, "读取失败", str(e))
            return
        self._reset_analysis()
        self.wave.set_audio(self.audio, self.sr)
        self.statusBar().showMessage(f"已载入 {Path(path).name}({self.sr} Hz,单声道混音)")

    def _reset_analysis(self):
        self.segments.clear()
        self.seg_list.clear()
        self.baseline = None
        self.processed = None
        self.notches = []
        self.chart.set_data([], [])
        self.result.clear()

    # ------------------------------------------------------------ 选段与分析

    def on_add_segment(self):
        if self.audio is None or not self.wave.sel:
            self.statusBar().showMessage("请先在波形上拖选一个区域")
            return
        a, b = self.wave.sel
        if b - a < 0.02:
            self.statusBar().showMessage("选区太小,请拖动选择")
            return
        self.segments.append((a, b))
        self.wave.segments = list(self.segments)
        self.wave.sel = None
        self.wave.update()
        self.seg_list.addItem(f"片段 {len(self.segments) - 1}: {a:.2f}s ~ {b:.2f}s")

    def on_clear_segments(self):
        self.segments.clear()
        self.seg_list.clear()
        self.wave.segments = []
        self.wave.update()

    def on_analyze(self):
        if self.audio is None:
            return
        if not self.segments:
            QMessageBox.information(self, "没有片段", "请先在波形上拖选并加入至少一段无声片段。")
            return
        reps = []
        for i, (a, b) in enumerate(self.segments):
            seg = self.audio[int(a * self.sr):int(b * self.sr)]
            reps.append(core.check_segment(seg, self.sr, i, a, b))
        self.baseline = core.build_baseline(reps)
        self._show_baseline(reps)

    def _show_baseline(self, reps):
        b = self.baseline
        self.seg_list.clear()
        for r in reps:
            tag = "✓" if r.accepted and not r.warnings else ("✗" if not r.accepted else "⚠")
            self.seg_list.addItem(
                f"{tag} 片段{r.index}: {r.start:.2f}~{r.end:.2f}s  RMS {r.rms_db:.1f} dBFS  "
                + ("; ".join(r.warnings) if r.warnings else ""))
        self.chart.set_data(b.band_median, b.band_spread)

        lines = [f"有效片段 {b.n_segments} 个,最大带间波动 {b.overall_spread_db:.1f} dB"]
        if b.hums:
            lines.append("突出窄频嗡声: " + ", ".join(
                f"{h['freq']:.0f}Hz(+{h['prominence_db']:.0f}dB, {h['segments']}段)" for h in b.hums))
        else:
            lines.append("未发现突出窄频嗡声")
        big = [d for d in b.drift if abs(d["delta_db"]) > core.DRIFT_WARN_DB]
        if big:
            lines.append("首尾基线漂移: " + ", ".join(
                f"{d['band_hz']:g}Hz {d['delta_db']:+.1f}dB" for d in big))
        elif b.n_segments >= 2:
            lines.append("首尾基线一致(各带漂移 ≤3 dB)")
        if b.warnings:
            lines.append("—— 警告 ——")
            lines.extend("⚠ " + w for w in b.warnings)
        self.result.setPlainText("\n".join(lines))
        self.statusBar().showMessage("基线分析完成")

    # ------------------------------------------------------------ 窄音减弱

    def on_reduce(self):
        if self.audio is None:
            return
        # 优先复用基线中确认的嗡声频率,否则在整段上自动估计
        freqs = [h["freq"] for h in self.baseline.hums] if self.baseline and self.baseline.hums else None
        self.processed, self.notches = core.reduce_tones(self.audio, self.sr, freqs)
        if not self.notches:
            self.result.appendPlainText("未检测到可减弱的稳定窄音。")
            return
        self.result.appendPlainText(
            "已陷波: " + ", ".join(f"{f:.0f}Hz" for f in self.notches) + ",可试听对比。")
        self.statusBar().showMessage("窄音减弱完成")

    def play(self, buf):
        if buf is None:
            self.statusBar().showMessage("没有可播放的音频")
            return
        path = self._tmp / f"play_{id(buf)}.wav"
        if not path.exists():
            core.write_wav(path, buf, self.sr)
        self.player.setSource(QUrl.fromLocalFile(str(path)))
        self.player.play()

    # ------------------------------------------------------------ 导出

    def on_export_wav(self):
        if self.processed is None:
            self.statusBar().showMessage("请先执行“估计并减弱稳定窄音”")
            return
        path, _ = QFileDialog.getSaveFileName(self, "导出处理音轨", "denoised.wav", "WAV (*.wav)")
        if path:
            core.write_wav(path, self.processed, self.sr)
            self.statusBar().showMessage(f"已导出 {path}")

    def on_export_profile(self):
        if self.baseline is None:
            self.statusBar().showMessage("请先执行“分析基线”")
            return
        path, _ = QFileDialog.getSaveFileName(self, "导出测量剖面", "profile.json", "JSON (*.json)")
        if path:
            self.baseline.to_json(path, extra={
                "sample_rate": self.sr,
                "band_centers_hz": core.BAND_CENTERS.tolist(),
                "tone_reduction": {"notches_hz": self.notches},
            })
            self.statusBar().showMessage(f"已导出 {path}")


def run_gui() -> int:
    app = QApplication([])
    win = MainWindow()
    win.show()
    return app.exec()
