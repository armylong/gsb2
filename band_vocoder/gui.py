"""PySide6 主窗口: 一条调制声 + 一条载波声的通道声码器。"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PySide6.QtCore import (QObject, QRunnable, QThreadPool, QTimer,
                            Signal, Slot)
from PySide6.QtWidgets import (QApplication, QComboBox, QDoubleSpinBox,
                               QFileDialog, QFormLayout, QGroupBox,
                               QHBoxLayout, QLabel, QMessageBox, QPushButton,
                               QSpinBox, QVBoxLayout, QWidget)

from . import INTERNAL_SR
from .audio_io import (fit_modulator, load_mono, loop_carrier, measure,
                       normalize_loudness, save_wav)
from .plots import EnergyBars, EnvelopePlot, WaveformPlot
from .player import Player
from .synth import (alternating_band_modulator, downsample_mean,
                    downsample_minmax, harmonic_carrier, sine_carrier, vocode)


# ---------------------------------------------------------------- 后台线程
class _SynthSignals(QObject):
    done = Signal(int, dict)
    failed = Signal(int, str)


class SynthTask(QRunnable):
    """一次声码器合成; 结果通过 signals 回主线程, 代次用于识别新旧。"""

    def __init__(self, generation, mod, car, sr, n_bands, attack, release):
        super().__init__()
        self.generation = generation
        self.signals = _SynthSignals()
        self._args = (mod, car, sr, n_bands, attack, release)

    @Slot()
    def run(self):
        try:
            res = vocode(*self._args)
            self.signals.done.emit(self.generation, res)
        except Exception as exc:  # 界面不能被 DSP 异常拖垮
            self.signals.failed.emit(
                self.generation, f"{type(exc).__name__}: {exc}")


# ---------------------------------------------------------------- 主窗口
class MainWindow(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("通道声码器 · 调制声 × 载波声")
        self.resize(1080, 860)

        self.sr = INTERNAL_SR
        self.mod_raw: np.ndarray | None = None      # 原始采样率读出的调制声
        self.mod_sr0 = 0
        self.car_raw: np.ndarray | None = None
        self.car_sr0 = 0
        self.car_path: str | None = None
        self.mod_aligned: np.ndarray | None = None
        self.car_aligned: np.ndarray | None = None
        self.result: dict | None = None
        self.selected_band = 0
        self._synth_generation = 0
        self._accepted_generation = 0
        self._busy = False
        self.player = Player()

        # 单线程池: 合成任务排队串行, 结果信号回到主线程事件循环处理。
        self._pool = QThreadPool(self)
        self._pool.setMaxThreadCount(1)

        self._build_ui()
        self._debounce = QTimer(self)
        self._debounce.setSingleShot(True)
        self._debounce.setInterval(180)
        self._debounce.timeout.connect(self._synth)

        # 启动即装入内置示例, 保证不找真人录音也能立刻测试
        self._load_demo_modulator()
        self._rebuild_carrier()
        self._align_and_schedule()

    # ------------------------------------------------------------ 界面
    def _build_ui(self):
        root = QVBoxLayout(self)

        # 输入区
        box_in = QGroupBox("1. 输入声音")
        form_in = QFormLayout(box_in)
        row_mod = QHBoxLayout()
        self.btn_mod = QPushButton("选择调制声 wav…")
        self.btn_demo = QPushButton("装入内置分频段示例")
        self.lbl_mod = QLabel("未加载")
        self.btn_mod.clicked.connect(self._choose_modulator)
        self.btn_demo.clicked.connect(self._load_demo_modulator)
        row_mod.addWidget(self.btn_mod)
        row_mod.addWidget(self.btn_demo)
        row_mod.addWidget(self.lbl_mod, 1)
        form_in.addRow("调制声(说话的起伏):", self._wrap(row_mod))

        row_car = QHBoxLayout()
        self.cmb_car = QComboBox()
        self.cmb_car.addItems(["内置: 单频正弦", "内置: 谐波串", "外部 wav 文件"])
        self.btn_car = QPushButton("选择载波 wav…")
        self.lbl_car = QLabel("")
        self.cmb_car.currentIndexChanged.connect(self._on_carrier_kind)
        self.btn_car.clicked.connect(self._choose_carrier)
        row_car.addWidget(self.cmb_car)
        row_car.addWidget(self.btn_car)
        row_car.addWidget(self.lbl_car, 1)
        form_in.addRow("载波声(持续响的合成音):", self._wrap(row_car))

        row_par = QHBoxLayout()
        self.spn_freq = QDoubleSpinBox()
        self.spn_freq.setRange(20, 8000)
        self.spn_freq.setValue(220)
        self.spn_f0 = QDoubleSpinBox()
        self.spn_f0.setRange(20, 2000)
        self.spn_f0.setValue(110)
        self.spn_harm = QSpinBox()
        self.spn_harm.setRange(1, 200)
        self.spn_harm.setValue(80)
        for w in (self.spn_freq, self.spn_f0, self.spn_harm):
            w.valueChanged.connect(self._on_builtin_param)
        row_par.addWidget(QLabel("单频 Hz"))
        row_par.addWidget(self.spn_freq)
        row_par.addWidget(QLabel("谐波基频 Hz"))
        row_par.addWidget(self.spn_f0)
        row_par.addWidget(QLabel("谐波数"))
        row_par.addWidget(self.spn_harm)
        form_in.addRow("内置载波参数:", self._wrap(row_par))
        self._on_carrier_kind()
        root.addWidget(box_in)

        # 参数区
        box_p = QGroupBox("2. 声码器参数")
        form_p = QFormLayout(box_p)
        self.spn_bands = QSpinBox()
        self.spn_bands.setRange(1, 32)
        self.spn_bands.setValue(16)
        self.spn_bands.valueChanged.connect(self._on_bands_changed)
        form_p.addRow("频带数:", self.spn_bands)

        self.spn_attack = QDoubleSpinBox()
        self.spn_attack.setRange(0.5, 500)
        self.spn_attack.setValue(10)
        self.spn_attack.setSuffix(" ms")
        self.spn_release = QDoubleSpinBox()
        self.spn_release.setRange(0.5, 1000)
        self.spn_release.setValue(60)
        self.spn_release.setSuffix(" ms")
        self.spn_attack.valueChanged.connect(self._schedule)
        self.spn_release.valueChanged.connect(self._schedule)
        form_p.addRow("包络跟随 attack(快→慢):", self.spn_attack)
        form_p.addRow("包络跟随 release(快→慢):", self.spn_release)

        row_dur = QHBoxLayout()
        self.cmb_dur = QComboBox()
        self.cmb_dur.addItems(["跟调制声长度", "跟载波长度", "固定时长"])
        self.spn_dur = QDoubleSpinBox()
        self.spn_dur.setRange(0.05, 60)
        self.spn_dur.setValue(2.0)
        self.spn_dur.setSuffix(" s")
        self.cmb_dur.currentIndexChanged.connect(self._align_and_schedule)
        self.spn_dur.valueChanged.connect(self._align_and_schedule)
        row_dur.addWidget(self.cmb_dur)
        row_dur.addWidget(self.spn_dur)
        form_p.addRow("处理时长:", self._wrap(row_dur))

        self.lbl_band = QLabel("选中带: -")
        form_p.addRow(self.lbl_band)
        root.addWidget(box_p)

        # 试听区
        box_play = QGroupBox("3. 试听 (保留天然静音间隔, 输出不含原调制声)")
        hp = QHBoxLayout(box_play)
        self.btn_play_mod = QPushButton("试听调制声")
        self.btn_play_car = QPushButton("试听载波声")
        self.btn_play_out = QPushButton("试听合成结果")
        self.btn_stop = QPushButton("停止")
        for b in (self.btn_play_mod, self.btn_play_car,
                  self.btn_play_out, self.btn_stop):
            hp.addWidget(b)
        self.btn_play_mod.clicked.connect(lambda: self._play(self.mod_aligned))
        self.btn_play_car.clicked.connect(lambda: self._play(self.car_aligned))
        self.btn_play_out.clicked.connect(self._play_output)
        self.btn_stop.clicked.connect(self.player.stop)
        root.addWidget(box_play)

        # 图形区
        self.plot_mod = WaveformPlot("调制声波形(静音间隔可见)")
        self.plot_car = WaveformPlot("载波声波形(循环接点已交叉淡化)")
        self.plot_env = EnvelopePlot()
        self.plot_bars = EnergyBars()
        self.plot_env.band_time_clicked.connect(self._on_plot_click)
        self.plot_bars.band_selected.connect(self._select_band)
        root.addWidget(self.plot_mod)
        root.addWidget(self.plot_car)
        root.addWidget(self.plot_bars)
        root.addWidget(self.plot_env, 1)

        # 导出区
        box_out = QGroupBox("4. 导出")
        ho = QHBoxLayout(box_out)
        self.btn_export = QPushButton("导出合成 wav…")
        self.btn_export.clicked.connect(self._export)
        self.lbl_measure = QLabel("导出后在此显示首尾响度/采样率/时长对照")
        ho.addWidget(self.btn_export)
        ho.addWidget(self.lbl_measure, 1)
        root.addWidget(box_out)

        self.status = QLabel("就绪")
        root.addWidget(self.status)

    @staticmethod
    def _wrap(layout) -> QWidget:
        w = QWidget()
        w.setLayout(layout)
        layout.setContentsMargins(0, 0, 0, 0)
        return w

    # ------------------------------------------------------------ 输入
    def _choose_modulator(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择调制声 wav", "", "WAV (*.wav)")
        if not path:
            return
        try:
            x, sr0 = load_mono(path, self.sr)
        except Exception as exc:
            QMessageBox.warning(self, "读取失败", str(exc))
            return
        self.mod_raw, self.mod_sr0 = x, sr0
        self.lbl_mod.setText(f"{Path(path).name}  原 {sr0}Hz "
                             f"{len(x)/self.sr:.2f}s")
        self._align_and_schedule()

    def _load_demo_modulator(self):
        dur = max(2.0, self.spn_dur.value())
        x = alternating_band_modulator(dur, self.sr,
                                       n_bands=self.spn_bands.value())
        self.mod_raw, self.mod_sr0 = x, self.sr
        self.lbl_mod.setText(f"内置示例: {self.spn_bands.value()} 带交替发声 "
                             f"{dur:.2f}s (含中间静音段)")
        self._align_and_schedule()

    def _choose_carrier(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择载波 wav", "", "WAV (*.wav)")
        if not path:
            return
        try:
            x, sr0 = load_mono(path, self.sr)
        except Exception as exc:
            QMessageBox.warning(self, "读取失败", str(exc))
            return
        self.car_raw, self.car_sr0, self.car_path = x, sr0, path
        self.cmb_car.setCurrentIndex(2)
        self.lbl_car.setText(f"{Path(path).name}  原 {sr0}Hz "
                             f"{len(x)/self.sr:.2f}s (短于此长度时循环)")
        self._align_and_schedule()

    def _on_carrier_kind(self):
        kind = self.cmb_car.currentIndex()
        is_file = kind == 2
        self.btn_car.setEnabled(is_file)
        self.spn_freq.setEnabled(kind == 0)
        self.spn_f0.setEnabled(kind == 1)
        self.spn_harm.setEnabled(kind == 1)
        self._rebuild_carrier()

    def _on_builtin_param(self):
        if self.cmb_car.currentIndex() != 2:
            self._rebuild_carrier()
            self._align_and_schedule()

    def _rebuild_carrier(self):
        kind = self.cmb_car.currentIndex()
        if kind == 2:
            if self.car_raw is None:
                self.lbl_car.setText("请选择外部载波 wav")
                return
        else:
            # 先按一个足够长的缓冲生成, 对齐阶段再截断/循环
            dur_value = self.spn_dur.value() if hasattr(self, "spn_dur") else 2.0
            mod_len = (len(self.mod_raw) / self.sr
                       if self.mod_raw is not None else 0)
            dur = max(5.0, dur_value + 1.0, mod_len)
            if kind == 0:
                self.car_raw = sine_carrier(dur, self.sr,
                                            freq=self.spn_freq.value())
            else:
                self.car_raw = harmonic_carrier(dur, self.sr,
                                                f0=self.spn_f0.value(),
                                                n_harmonics=self.spn_harm.value())
            self.car_sr0 = self.sr
            self.car_path = None
            self.lbl_car.setText(
                f"内置{'单频' if kind == 0 else '谐波'}载波, "
                f"缓冲 {dur:.1f}s, 按处理时长截断")
        self._align_and_schedule()

    # ------------------------------------------------------------ 时长对齐
    def _target_length(self) -> int:
        mode = self.cmb_dur.currentIndex()
        if mode == 0:
            return len(self.mod_raw)
        if mode == 1:
            return len(self.car_raw)
        return max(1, int(round(self.spn_dur.value() * self.sr)))

    def _align_and_schedule(self):
        if self.mod_raw is None or self.car_raw is None:
            return
        n = self._target_length()
        new_mod = fit_modulator(self.mod_raw, n)
        new_car = loop_carrier(self.car_raw, n, self.sr)
        # 长度与内容都没变时不重算(控件信号可能在同一迭代里连发两次)。
        if (self.mod_aligned is not None
                and len(self.mod_aligned) == n
                and np.array_equal(new_mod, self.mod_aligned)
                and np.array_equal(new_car, self.car_aligned)):
            return
        self.mod_aligned = new_mod
        self.car_aligned = new_car
        self._refresh_input_plots()
        self._schedule()

    # ------------------------------------------------------------ 参数变化
    def _on_bands_changed(self):
        # 关键: 频带数变了, 旧的带编号已经失效。
        # 按"在频带数轴上的相对位置"重新映射, 再夹到合法范围,
        # 读数永远指向当前滤波器组里真实存在的带。
        old_n = self._last_band_count()
        new_n = self.spn_bands.value()
        if old_n:
            rel = self.selected_band / max(1, old_n - 1)
            self.selected_band = int(round(rel * (new_n - 1)))
        self.selected_band = int(np.clip(self.selected_band, 0, new_n - 1))
        if self.cmb_car.currentIndex() != 2:
            self._rebuild_carrier()
        self._schedule()

    def _last_band_count(self) -> int:
        if self.result is not None:
            return len(self.result["edges"]) - 1
        return self.spn_bands.value()

    def _schedule(self):
        # 参数变化到合成之间有防抖窗口, 这段时间也标记为忙,
        # 避免外部轮询在"旧结果已完成、新合成未发起"的间隙误判为空闲。
        self._busy = True
        self._debounce.start()

    # ------------------------------------------------------------ 合成
    def _synth(self):
        if self.mod_aligned is None or self.car_aligned is None:
            self._busy = False
            return
        self.status.setText("合成中…")
        self._synth_generation += 1
        self._busy = True
        task = SynthTask(
            self._synth_generation,
            self.mod_aligned, self.car_aligned, self.sr,
            self.spn_bands.value(),
            self.spn_attack.value(), self.spn_release.value())
        # signals 属主线程, 槽在主线程事件循环执行, 无线程亲和性问题。
        task.signals.done.connect(self._accept_synth)
        task.signals.failed.connect(self._accept_failure)
        self._pool.start(task)

    @property
    def synth_busy(self) -> bool:
        return self._busy

    @Slot(int, dict)
    def _accept_synth(self, generation: int, res: dict):
        # 队列里可能有参数抖动产生的旧任务, 只接受最新一代。
        if generation < self._synth_generation:
            return
        self._busy = False
        self._accepted_generation = generation
        self._on_synth_done(res)

    @Slot(int, str)
    def _accept_failure(self, generation: int, msg: str):
        if generation < self._synth_generation:
            return
        self._busy = False
        self._on_synth_failed(msg)

    @Slot(dict)
    def _on_synth_done(self, res: dict):
        self.result = res
        n_bands = len(res["edges"]) - 1
        self.selected_band = int(np.clip(self.selected_band, 0, n_bands - 1))
        self.plot_bars.set_energy(res["carrier_energy"], self.selected_band)
        self._refresh_band_plot()
        self.status.setText(
            f"合成完成: {n_bands} 带, 输出 "
            f"{len(res['output'])/self.sr:.2f}s · "
            "输出仅由载波分带 × 调制包络构成, 未混回原调制声")

    @Slot(str)
    def _on_synth_failed(self, msg: str):
        self.status.setText(f"合成失败: {msg}")

    # ------------------------------------------------------------ 图形
    def _refresh_input_plots(self):
        if self.mod_aligned is not None:
            lo, hi = downsample_minmax(self.mod_aligned)
            self.plot_mod.set_waveform(lo, hi)
        if self.car_aligned is not None:
            lo, hi = downsample_minmax(self.car_aligned)
            self.plot_car.set_waveform(lo, hi)

    def _refresh_band_plot(self):
        if self.result is None:
            return
        i = self.selected_band
        edges = self.result["edges"]
        env = downsample_mean(self.result["envelopes"][i])
        out_band = downsample_mean(np.abs(self.result["band_outputs"][i]))
        dead = self.result["carrier_energy"][i] < \
            0.01 * self.result["carrier_energy"].max()
        self.plot_env.set_curves(env, out_band, dead)
        self.plot_bars.set_energy(self.result["carrier_energy"], i)
        self.lbl_band.setText(
            f"选中带: #{i}  频率 {edges[i]:.0f}–{edges[i+1]:.0f} Hz"
            + ("  [载波在此带无能量]" if dead else ""))

    def _select_band(self, idx: int):
        if self.result is None:
            return
        self.selected_band = int(np.clip(idx, 0,
                                         len(self.result["edges"]) - 2))
        self._refresh_band_plot()

    def _on_plot_click(self, frac: float):
        # 预留: 点击包络图可在此扩展游标; 当前保证信号不丢即可。
        self.status.setText(f"包络图点击位置 t="
                            f"{frac * len(self.mod_aligned) / self.sr:.2f}s")

    def closeEvent(self, event):
        self.player.stop()
        self._pool.clear()
        self._pool.waitForDone(2000)
        super().closeEvent(event)

    # ------------------------------------------------------------ 播放/导出
    def _play(self, x: np.ndarray | None):
        if x is None:
            return
        y, _ = normalize_loudness(x)
        try:
            self.player.play(y, self.sr)
        except Exception as exc:
            QMessageBox.warning(self, "播放失败", str(exc))

    def _play_output(self):
        if self.result is not None:
            self._play(self.result["output"])

    def _export(self):
        if self.result is None:
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "导出合成结果", "vocoder_out.wav", "WAV (*.wav)")
        if not path:
            return
        y, scale = normalize_loudness(self.result["output"])
        save_wav(path, y, self.sr)
        m = measure(y, self.sr)
        m_mod = measure(self.mod_aligned, self.sr)
        m_car = measure(self.car_aligned, self.sr)
        self.lbl_measure.setText(
            f"导出 {Path(path).name}: sr={m['sr']}Hz "
            f"{m['duration_s']:.3f}s RMS={m['rms']:.3f} peak={m['peak']:.3f} "
            f"| 首50ms RMS={m['head_rms']:.4f} 尾50ms RMS={m['tail_rms']:.4f} "
            f"| 调制声RMS={m_mod['rms']:.3f} 载波RMS={m_car['rms']:.3f} "
            f"缩放={scale:.2f}")
        self.status.setText("已导出, 可在外部播放器对照首尾、采样率与响度")


def main():
    app = QApplication.instance() or QApplication([])
    win = MainWindow()
    win.show()
    app.exec()

if __name__ == "__main__":
    main()
