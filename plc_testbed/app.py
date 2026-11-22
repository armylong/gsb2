"""PySide6 图形界面:离线丢包/乱序补偿试验台。"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt, QUrl
from PySide6.QtMultimedia import QSoundEffect
from PySide6.QtWidgets import (
    QApplication, QComboBox, QDoubleSpinBox, QFileDialog, QFormLayout,
    QGroupBox, QHBoxLayout, QLabel, QMainWindow, QMessageBox, QPushButton,
    QSpinBox, QSplitter, QTextEdit, QVBoxLayout, QWidget,
)
from matplotlib.backends.backend_qtagg import FigureCanvasQTAgg
from matplotlib.figure import Figure

from .core import (PRESETS, PRESET_LABELS, EngineParams, SAMPLE_RATE,
                   run_simulation, synth_chirp, synth_speech_like)
from .storage import export_all, read_wav, write_wav


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("语音丢包/乱序补偿离线试验台")
        self.resize(1280, 860)

        self.sr = SAMPLE_RATE
        self.source_desc = "合成语音(3s)"
        self.source_samples = synth_speech_like(3.0, self.sr)
        self.result = None
        self.baseline_stats = None
        self.last_export_wav: Path | None = None
        self._tmp_files: list[str] = []
        self._player = QSoundEffect(self)

        self._build_ui()
        self.run_simulation()

    # ------------------------------------------------------------ UI 搭建
    def _build_ui(self):
        root = QSplitter(Qt.Horizontal)
        self.setCentralWidget(root)

        # ---- 左侧控制面板 ----
        panel = QWidget()
        v = QVBoxLayout(panel)

        src_box = QGroupBox("素材")
        f = QFormLayout(src_box)
        self.src_combo = QComboBox()
        self.src_combo.addItems(["合成语音(3s)", "合成扫频(3s)", "导入 WAV..."])
        self.src_combo.currentIndexChanged.connect(self.load_source)
        f.addRow("来源", self.src_combo)
        v.addWidget(src_box)

        sim_box = QGroupBox("模拟参数")
        f = QFormLayout(sim_box)
        self.packet_ms = QDoubleSpinBox(minimum=5, maximum=100, value=20,
                                        singleStep=5, suffix=" ms")
        f.addRow("包长度", self.packet_ms)
        self.preset_combo = QComboBox()
        self.preset_combo.addItems([PRESET_LABELS[p] for p in PRESETS])
        self.preset_combo.setCurrentIndex(PRESETS.index("mixed"))
        self.preset_combo.currentIndexChanged.connect(self._preset_changed)
        f.addRow("扰动样例", self.preset_combo)
        self.seed_spin = QSpinBox(minimum=0, maximum=99999, value=1)
        f.addRow("随机种子", self.seed_spin)
        self.loss_rate = QDoubleSpinBox(minimum=0, maximum=1, value=0.10,
                                        singleStep=0.05, decimals=2)
        f.addRow("丢包率(custom)", self.loss_rate)
        self.jitter_max = QDoubleSpinBox(minimum=0, maximum=500, value=30,
                                         singleStep=5, suffix=" ms")
        f.addRow("抖动上限(custom)", self.jitter_max)
        self.playout_delay = QDoubleSpinBox(minimum=0, maximum=1000, value=100,
                                            singleStep=20, suffix=" ms")
        f.addRow("接收缓冲(等多久才放)", self.playout_delay)
        self.plc_combo = QComboBox()
        self.plc_combo.addItems(["短时填补(基音重复+衰减)", "补静音"])
        f.addRow("补偿方式", self.plc_combo)
        v.addWidget(sim_box)

        btn_row = QHBoxLayout()
        self.run_btn = QPushButton("运行模拟")
        self.run_btn.clicked.connect(self.run_simulation)
        btn_row.addWidget(self.run_btn)
        self.base_btn = QPushButton("设为对照基准")
        self.base_btn.clicked.connect(self.set_baseline)
        btn_row.addWidget(self.base_btn)
        self.export_btn = QPushButton("导出结果...")
        self.export_btn.clicked.connect(self.export_results)
        btn_row.addWidget(self.export_btn)
        v.addLayout(btn_row)

        self.stats_text = QTextEdit(readOnly=True)
        self.stats_text.setMinimumHeight(180)
        v.addWidget(self.stats_text)
        v.addStretch(1)
        root.addWidget(panel)

        # ---- 右侧:图 + 试听区 ----
        right = QWidget()
        rv = QVBoxLayout(right)
        self.fig = Figure(figsize=(8, 9), tight_layout=True)
        self.canvas = FigureCanvasQTAgg(self.fig)
        self.ax_wave, self.ax_pkt, self.ax_cmp = self.fig.subplots(
            3, 1, height_ratios=[2, 2, 1])
        rv.addWidget(self.canvas, stretch=1)

        listen_box = QGroupBox("区间试听 / 导出核对(左右区间对预览和导出文件一致)")
        h = QHBoxLayout(listen_box)
        h.addWidget(QLabel("缺口"))
        self.gap_combo = QComboBox()
        self.gap_combo.currentIndexChanged.connect(self.on_gap_selected)
        h.addWidget(self.gap_combo, stretch=1)
        h.addWidget(QLabel("左"))
        self.seg_start = QDoubleSpinBox(minimum=0, maximum=1e6, value=0,
                                        singleStep=20, suffix=" ms")
        h.addWidget(self.seg_start)
        h.addWidget(QLabel("右"))
        self.seg_end = QDoubleSpinBox(minimum=0, maximum=1e6, value=200,
                                      singleStep=20, suffix=" ms")
        h.addWidget(self.seg_end)
        self.play_btn = QPushButton("试听区间")
        self.play_btn.clicked.connect(self.play_segment)
        h.addWidget(self.play_btn)
        self.cmp_btn = QPushButton("对比导出样本")
        self.cmp_btn.clicked.connect(self.compare_export)
        h.addWidget(self.cmp_btn)
        rv.addWidget(listen_box)
        root.addWidget(right)
        root.setSizes([360, 920])

        self._preset_changed()

    # ------------------------------------------------------------ 参数收集
    def _preset_changed(self):
        custom = PRESETS[self.preset_combo.currentIndex()] == "custom"
        self.loss_rate.setEnabled(custom)
        self.jitter_max.setEnabled(custom)

    def collect_params(self) -> EngineParams:
        return EngineParams(
            packet_ms=self.packet_ms.value(),
            playout_delay_ms=self.playout_delay.value(),
            plc_mode="extrapolate" if self.plc_combo.currentIndex() == 0 else "silence",
            preset=PRESETS[self.preset_combo.currentIndex()],
            seed=self.seed_spin.value(),
            loss_rate=self.loss_rate.value(),
            jitter_max_ms=self.jitter_max.value(),
        )

    # ------------------------------------------------------------ 动作
    def load_source(self):
        idx = self.src_combo.currentIndex()
        try:
            if idx == 0:
                self.source_samples = synth_speech_like(3.0, self.sr)
                self.source_desc = "合成语音(3s)"
            elif idx == 1:
                self.source_samples = synth_chirp(3.0, self.sr)
                self.source_desc = "合成扫频(3s)"
            else:
                path, _ = QFileDialog.getOpenFileName(
                    self, "选择 WAV 文件", "", "WAV (*.wav)")
                if not path:
                    self.src_combo.setCurrentIndex(0)
                    return
                self.source_samples, _ = read_wav(path, self.sr)
                self.source_desc = f"WAV: {Path(path).name}"
        except Exception as e:  # noqa: BLE001
            QMessageBox.warning(self, "导入失败", str(e))
            self.src_combo.setCurrentIndex(0)
            return
        self.run_simulation()

    def run_simulation(self):
        params = self.collect_params()
        self.result = run_simulation(self.source_samples, self.sr, params)
        self.refresh_stats()
        self.refresh_plots()
        self.refresh_gap_combo()

    def set_baseline(self):
        if self.result:
            self.baseline_stats = dict(self.result.stats)
            self.refresh_stats()

    def refresh_stats(self):
        s = self.result.stats
        lines = [
            f"包数 {s['n_packets']}  播放 {s['n_played']}  "
            f"迟到丢弃 {s['n_late']}  丢失 {s['n_lost']}",
            f"缺口 {s['n_gaps']} 处,最长 {s['longest_gap_ms']:.0f} ms",
            f"补偿时隙 {s['concealed_slots']} 个 / "
            f"{s['concealed_samples']} 样本 ({s['concealed_ms']:.0f} ms)",
            f"多等(缓冲) {s['added_wait_ms']:.0f} ms   "
            f"流总长 {s['stream_ms']:.0f} ms",
            f"流尾包样本数 {s['tail_packet_samples']} / {s['packet_samples']}",
        ]
        if self.baseline_stats:
            b = self.baseline_stats
            lines.append("— 相对对照基准 —")
            lines.append(
                f"Δ补偿 {s['concealed_samples'] - b['concealed_samples']:+d} 样本 "
                f"({s['concealed_ms'] - b['concealed_ms']:+.0f} ms)   "
                f"Δ多等 {s['added_wait_ms'] - b['added_wait_ms']:+.0f} ms")
        self.stats_text.setPlainText("\n".join(lines))

    def refresh_plots(self):
        r = self.result
        t = np.arange(len(r.output)) / r.sr * 1000.0

        ax = self.ax_wave
        ax.clear()
        ax.plot(t, r.output, lw=0.5, color="0.4")
        for g in r.gaps:
            ax.axvspan(g["start_ms"], g["end_ms"], color="tab:red", alpha=0.25)
            if g["recovery_sample"] >= 0:
                ax.axvline(g["recovery_ms"], color="tab:green", lw=1)
        ax.set_title("实际播放输出(红=补偿缺口,绿=恢复位置,黄=试听区间)")
        ax.set_ylabel("幅度")
        ax.set_xlim(0, t[-1] if len(t) else 1)
        self._sel_span = ax.axvspan(self.seg_start.value(), self.seg_end.value(),
                                    color="gold", alpha=0.3)

        ax = self.ax_pkt
        ax.clear()
        send = [p.send_ms for p in r.packets]
        sched = [p.sched_play_ms for p in r.packets]
        ax.vlines(send, 0.15, 0.35, color="gray", lw=1, label="本来该播")
        ax.plot(sched, [0.75] * len(sched), "|", color="tab:green", ms=8,
                label="安排播放")
        for p in r.packets:
            if p.status == "played":
                ax.plot(p.arrival_ms, 0.5, "o", color="tab:blue", ms=3)
            elif p.status == "late":
                ax.plot(p.arrival_ms, 0.5, "o", color="tab:orange", ms=4)
            else:
                ax.plot(p.send_ms, 0.5, "x", color="tab:red", ms=5)
        ax.plot([], [], "o", color="tab:blue", label="送到(播放)")
        ax.plot([], [], "o", color="tab:orange", label="送到(迟到丢弃)")
        ax.plot([], [], "x", color="tab:red", label="丢失")
        ax.set_yticks([0.25, 0.5, 0.75])
        ax.set_yticklabels(["该播", "送到", "播放"])
        ax.set_ylim(0, 1)
        ax.set_xlabel("时间 ms")
        ax.legend(loc="upper right", fontsize=8, ncol=3)
        ax.set_title("每包时刻:本来该播 / 模拟送到 / 安排播放")

        self.ax_cmp.clear()
        self.ax_cmp.set_title("导出对比(选区间后点“对比导出样本”)")
        self.canvas.draw_idle()

    def refresh_gap_combo(self):
        self.gap_combo.blockSignals(True)
        self.gap_combo.clear()
        self.gap_combo.addItem("(手动选区间)", None)
        for g in self.result.gaps:
            label = (f"缺口{g['gap_id']}: {g['start_ms']:.0f}–{g['end_ms']:.0f} ms "
                     f"({g['n_slots']}包"
                     + (f", 恢复@{g['recovery_ms']:.0f}ms"
                        if g['recovery_sample'] >= 0 else ", 到流尾")
                     + ")")
            self.gap_combo.addItem(label, (g["start_ms"], g["end_ms"]))
        self.gap_combo.blockSignals(False)

    def on_gap_selected(self):
        data = self.gap_combo.currentData()
        if data:
            self.seg_start.setValue(data[0])
            self.seg_end.setValue(data[1])
        self._update_sel_span()

    def _update_sel_span(self):
        if hasattr(self, "_sel_span"):
            lo, hi = self.seg_start.value(), self.seg_end.value()
            self._sel_span.remove()
            self._sel_span = self.ax_wave.axvspan(lo, hi, color="gold", alpha=0.3)
            self.canvas.draw_idle()

    def _segment(self, samples, sr):
        lo = int(self.seg_start.value() / 1000.0 * sr)
        hi = int(self.seg_end.value() / 1000.0 * sr)
        lo, hi = max(0, lo), min(len(samples), hi)
        return samples[lo:hi] if hi > lo else np.zeros(0)

    def play_segment(self):
        if not self.result:
            return
        seg = self._segment(self.result.output, self.sr)
        if len(seg) == 0:
            return
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
        tmp.close()
        write_wav(tmp.name, seg, self.sr)
        self._tmp_files.append(tmp.name)
        self._player.setSource(QUrl.fromLocalFile(tmp.name))
        self._player.play()

    def export_results(self):
        if not self.result:
            return
        d = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not d:
            return
        wav_path, csv_path, json_path = export_all(d, self.result, self.source_desc)
        self.last_export_wav = wav_path
        QMessageBox.information(
            self, "导出完成",
            f"实际输出: {wav_path}\n包记录: {csv_path}\n配置: {json_path}")

    def compare_export(self):
        """同一左右区间,对比导出 WAV 与当前预览输出是否一致。"""
        if not self.result:
            return
        path = self.last_export_wav
        if not path or not Path(path).exists():
            p, _ = QFileDialog.getOpenFileName(
                self, "选择导出的 actual_output.wav", "", "WAV (*.wav)")
            if not p:
                return
            path = Path(p)
        exported, _ = read_wav(path, self.sr)
        prev_seg = self._segment(self.result.output, self.sr)
        exp_seg = self._segment(exported, self.sr)
        n = min(len(prev_seg), len(exp_seg))
        if n == 0:
            QMessageBox.warning(self, "对比失败", "区间为空")
            return
        # 导出经过 int16 量化,允许 1 LSB 误差
        diff = np.abs(prev_seg[:n] - exp_seg[:n])
        max_diff = float(diff.max())
        tol = 1.0 / 32767.0 + 1e-9
        ok = max_diff <= tol and len(prev_seg) == len(exp_seg)

        ax = self.ax_cmp
        ax.clear()
        t0 = self.seg_start.value()
        tt = t0 + np.arange(n) / self.sr * 1000.0
        ax.plot(tt, prev_seg[:n], lw=0.8, label="预览")
        ax.plot(tt, exp_seg[:n], lw=0.8, ls="--", label="导出")
        ax.plot(tt, prev_seg[:n] - exp_seg[:n], lw=0.6, color="tab:red",
                label="差")
        ax.legend(fontsize=8)
        ax.set_title(f"区间 {t0:.0f}–{self.seg_end.value():.0f} ms  "
                     f"最大差 {max_diff:.2e}  "
                     + ("一致 ✓" if ok else "不一致 ✗"))
        self.canvas.draw_idle()
        self.stats_text.append(
            f"\n导出对比 [{t0:.0f},{self.seg_end.value():.0f}] ms: "
            f"最大差 {max_diff:.2e}, {'一致' if ok else '不一致'}")

    def closeEvent(self, event):
        for p in self._tmp_files:
            try:
                Path(p).unlink(missing_ok=True)
            except OSError:
                pass
        super().closeEvent(event)


def main():
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
