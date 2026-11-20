"""PySide6 图形界面：短音频限幅前后对比。

启动：python -m limiter.app
"""

from __future__ import annotations

import os

import matplotlib

matplotlib.use("QtAgg")

import numpy as np
from matplotlib.figure import Figure
from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QFileDialog, QFormLayout,
    QGroupBox, QHBoxLayout, QLabel, QMainWindow, QMessageBox,
    QPushButton, QDoubleSpinBox, QSpinBox, QSplitter, QTextEdit,
    QVBoxLayout, QWidget,
)
from matplotlib.backends.backend_qtagg import FigureCanvasQTAgg as FigureCanvas

from . import dsp, sources, wavio


def _setup_fonts() -> bool:
    """探测系统中文字体并配置给 matplotlib；找不到则返回 False 用英文标题。"""
    from matplotlib import font_manager

    candidates = [
        "PingFang SC", "Hiragino Sans GB", "Heiti SC",
        "Songti SC", "STHeiti", "Arial Unicode MS",
        "Noto Sans CJK SC", "Microsoft YaHei",
    ]
    available = {f.name for f in font_manager.fontManager.ttflist}
    for name in candidates:
        if name in available:
            matplotlib.rcParams["font.sans-serif"] = [name, "DejaVu Sans"]
            matplotlib.rcParams["axes.unicode_minus"] = False
            return True
    return False


HAS_CJK_FONT = _setup_fonts()


def _t(zh: str, en: str) -> str:
    """图表标题：有中文字体用中文，否则英文，避免缺字方框。"""
    return zh if HAS_CJK_FONT else en

# 每个通道输入 / 输出 / 增益的配色。
COLORS = {
    "L_in": "#888888", "R_in": "#b0b0b0",
    "L_out": "#1f77b4", "R_out": "#d62728",
    "gainL": "#2ca02c", "gainR": "#ff7f0e",
    "ceil": "#d62728",
}


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("短音频限幅对比 — lookahead limiter")
        self.resize(1280, 860)

        self.fs = 48000.0
        self.x: np.ndarray | None = None
        self.source_meta: dict = {}
        self.loaded_path: str | None = None
        self._building = True

        self._build_ui()
        self._load_source(0)
        self._building = False
        self.reprocess()

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        splitter = QSplitter(Qt.Horizontal)

        # ---- 左控制面板 ------------------------------------------------
        side = QWidget()
        side.setMinimumWidth(300)
        side.setMaximumWidth(380)
        lay = QVBoxLayout(side)

        src_box = QGroupBox("素材")
        src_lay = QVBoxLayout(src_box)
        self.source_combo = QComboBox()
        self.source_combo.addItems([
            "窄脉冲（单声道，1 采样尖峰）",
            "连续正弦音 1kHz（单声道）",
            "立体声（尖峰仅在 R）",
            "超短脉冲 48 采样（短于提前量）",
            "从 WAV 文件载入…",
        ])
        self.source_combo.currentIndexChanged.connect(self._on_source_changed)
        src_lay.addWidget(self.source_combo)
        self.source_label = QLabel()
        self.source_label.setWordWrap(True)
        src_lay.addWidget(self.source_label)
        lay.addWidget(src_box)

        par_box = QGroupBox("限幅参数")
        form = QFormLayout(par_box)

        self.ceiling_spin = QDoubleSpinBox()
        self.ceiling_spin.setRange(-24.0, 0.0)
        self.ceiling_spin.setValue(-1.0)
        self.ceiling_spin.setSuffix(" dBFS")
        self.ceiling_spin.setSingleStep(0.5)
        self.ceiling_spin.valueChanged.connect(self._schedule_reprocess)
        form.addRow("峰值上限", self.ceiling_spin)

        self.lookahead_spin = QDoubleSpinBox()
        self.lookahead_spin.setRange(0.0, 20.0)
        self.lookahead_spin.setValue(round(128 / self.fs * 1000, 3))
        self.lookahead_spin.setSuffix(" ms")
        self.lookahead_spin.setSingleStep(0.5)
        self.lookahead_spin.setDecimals(3)
        self.lookahead_spin.valueChanged.connect(self._schedule_reprocess)
        form.addRow("提前量 lookahead", self.lookahead_spin)
        self.lookahead_info = QLabel()
        form.addRow("", self.lookahead_info)

        self.release_spin = QDoubleSpinBox()
        self.release_spin.setRange(0.0, 500.0)
        self.release_spin.setValue(20.0)
        self.release_spin.setSuffix(" ms")
        self.release_spin.setSingleStep(5.0)
        self.release_spin.valueChanged.connect(self._schedule_reprocess)
        form.addRow("恢复时间 release", self.release_spin)

        self.linked_chk = QCheckBox("两声道联动（共用增益曲线，保持声像）")
        self.linked_chk.setChecked(True)
        self.linked_chk.toggled.connect(self._schedule_reprocess)
        form.addRow(self.linked_chk)

        self.tp_chk = QCheckBox("true-peak 保护（重建峰也不超线）")
        self.tp_chk.toggled.connect(self._schedule_reprocess)
        form.addRow(self.tp_chk)

        lay.addWidget(par_box)

        btn_row = QHBoxLayout()
        self.run_btn = QPushButton("重新处理")
        self.run_btn.clicked.connect(self.reprocess)
        self.export_btn = QPushButton("导出 WAV…")
        self.export_btn.clicked.connect(self.export_wav)
        btn_row.addWidget(self.run_btn)
        btn_row.addWidget(self.export_btn)
        lay.addLayout(btn_row)

        self.fmt_combo = QComboBox()
        self.fmt_combo.addItems(["32-bit float（推荐，不再截断）", "16-bit PCM"])
        lay.addWidget(self.fmt_combo)

        stat_box = QGroupBox("实测峰值 / 声像核对")
        stat_lay = QVBoxLayout(stat_box)
        self.stats_view = QTextEdit()
        self.stats_view.setReadOnly(True)
        self.stats_view.setMinimumHeight(260)
        stat_lay.addWidget(self.stats_view)
        lay.addWidget(stat_box, stretch=1)

        self.latency_label = QLabel()
        self.latency_label.setWordWrap(True)
        lay.addWidget(self.latency_label)

        # ---- 右图表区 --------------------------------------------------
        self.figure = Figure(figsize=(9, 9), layout="tight")
        self.canvas = FigureCanvas(self.figure)
        self.ax_wave = self.figure.add_subplot(3, 1, 1)
        self.ax_gain = self.figure.add_subplot(3, 1, 2, sharex=self.ax_wave)
        self.ax_tp = self.figure.add_subplot(3, 1, 3)

        splitter.addWidget(side)
        splitter.addWidget(self.canvas)
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        self.setCentralWidget(splitter)

    # ------------------------------------------------------------ 素材
    def _on_source_changed(self, idx: int) -> None:
        if self._building:
            return
        if idx == 4:
            self._open_wav()
        else:
            self._load_source(idx)
            self.reprocess()

    def _load_source(self, idx: int) -> None:
        keys = ["pulse", "tone", "stereo", "short"]
        fn = sources.SOURCES[keys[idx]]
        self.x, self.source_meta = fn(self.fs)
        self.loaded_path = None
        self.source_label.setText(
            f"{self.source_meta['name']}\n"
            f"{self.x.shape[0]} 采样 / {self.x.shape[0] / self.fs * 1000:.2f} ms "
            f"@ {self.fs:g} Hz，"
            f"{'立体声' if self.x.ndim == 2 else '单声道'}"
        )

    def _open_wav(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择短 WAV 文件", "", "WAV (*.wav *.wave)")
        if not path:
            # 用户取消，恢复 combo 到实际素材。
            self.source_combo.blockSignals(True)
            self.source_combo.setCurrentIndex(0)
            self.source_combo.blockSignals(False)
            return
        try:
            x, fs = wavio.read_wav(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "读取失败", str(exc))
            return
        self.x, self.fs, self.loaded_path = x, fs, path
        self.source_meta = {"name": os.path.basename(path), "peaks_idx": []}
        ch = "立体声" if x.ndim == 2 else "单声道"
        n = x.shape[0]
        self.source_label.setText(
            f"{os.path.basename(path)}\n{n} 采样 / {n / fs * 1000:.2f} ms "
            f"@ {fs:g} Hz，{ch}"
        )
        self.reprocess()

    def _schedule_reprocess(self, *_args) -> None:
        if not self._building:
            self.reprocess()

    # ------------------------------------------------------------ 处理
    def reprocess(self) -> None:
        if self.x is None:
            return
        lookahead_ms = self.lookahead_spin.value()
        lookahead = int(round(lookahead_ms * 1e-3 * self.fs))
        self.lookahead_info.setText(f"= {lookahead} 采样")

        mono = self.x.ndim == 1
        linked = self.linked_chk.isChecked() and not mono
        self.res = dsp.limit(
            self.x,
            ceiling_db=self.ceiling_spin.value(),
            lookahead=lookahead,
            release_ms=self.release_spin.value(),
            fs=self.fs,
            linked=linked,
            true_peak_guard=self.tp_chk.isChecked(),
        )
        self._update_plots()
        self._update_stats()

    # ------------------------------------------------------------ 图表
    def _update_plots(self) -> None:
        x, res, fs = self.x, self.res, self.fs
        mono = x.ndim == 1
        n = x.shape[0]
        t_ms = np.arange(n) / fs * 1000.0
        ceil = res.ceiling

        # --- 波形：输入淡色 + 输出实色 + ceiling 线 ---------------------
        ax = self.ax_wave
        ax.clear()
        if mono:
            ax.plot(t_ms, x, color=COLORS["L_in"], lw=0.8, label=_t("输入", "input"))
            ax.plot(t_ms, res.y, color=COLORS["L_out"], lw=1.0,
                    label=_t("输出", "output"))
        else:
            ax.plot(t_ms, x[:, 0], color=COLORS["L_in"], lw=0.7,
                    label=_t("输入 L", "input L"))
            ax.plot(t_ms, x[:, 1], color=COLORS["R_in"], lw=0.7,
                    label=_t("输入 R", "input R"))
            ax.plot(t_ms, res.y[:, 0], color=COLORS["L_out"], lw=1.0,
                    label=_t("输出 L", "output L"))
            ax.plot(t_ms, res.y[:, 1], color=COLORS["R_out"], lw=1.0,
                    label=_t("输出 R", "output R"))
        ax.axhline(ceil, color=COLORS["ceil"], ls="--", lw=1,
                   label=_t(f"上限 {dsp.to_dbfs(ceil):.2f} dBFS",
                            f"ceiling {dsp.to_dbfs(ceil):.2f} dBFS"))
        ax.axhline(-ceil, color=COLORS["ceil"], ls="--", lw=1)
        ax.set_ylabel(_t("幅度", "amplitude"))
        ax.set_title(_t("波形对比（虚线为峰值上限）",
                        "Waveform (dashed = ceiling)"))
        ax.legend(loc="upper right", fontsize=8, ncol=3)
        ax.grid(alpha=0.3)

        # --- 实际增益曲线 ------------------------------------------------
        ax = self.ax_gain
        ax.clear()
        if mono:
            ax.plot(t_ms, res.gain, color=COLORS["gainL"], lw=1.2,
                    label=_t("增益", "gain"))
        else:
            ax.plot(t_ms, res.gain[:, 0], color=COLORS["gainL"], lw=1.2,
                    label=_t("增益 L", "gain L"))
            ax.plot(t_ms, res.gain[:, 1], color=COLORS["gainR"], lw=1.2,
                    label=_t("增益 R", "gain R"))
        ax.set_ylabel(_t("线性增益", "linear gain"))
        if mono:
            mode = _t("单声道", "mono")
        elif res.linked:
            mode = _t("联动（两声道同曲线）", "linked (shared curve)")
        else:
            mode = _t("独立声道", "independent channels")
        ax.set_title(_t(f"实际增益曲线 — {mode}", f"Actual gain curve — {mode}"))
        ax.set_ylim(-0.02, 1.05)
        ax.legend(loc="lower right", fontsize=8)
        ax.grid(alpha=0.3)

        # --- 重建峰：最大峰值附近 4x 过采样 ------------------------------
        ax = self.ax_tp
        ax.clear()
        sp = dsp.sample_peak(res.y)
        ch_idx = int(np.argmax(sp))
        sig = res.y if mono else res.y[:, ch_idx]
        peak_i = int(np.argmax(np.abs(sig)))
        half = min(32, n // 2)
        lo, hi = max(0, peak_i - half), min(n, peak_i + half)
        seg = sig[lo:hi]
        from scipy.signal import resample_poly
        seg_os = resample_poly(seg, 4, 1, window=("kaiser", 5.0))
        t_os = (lo + np.arange(seg_os.size) / 4.0) / fs * 1000.0
        t_seg = (lo + np.arange(seg.size)) / fs * 1000.0
        ax.plot(t_os, seg_os, color="#9467bd", lw=1.0,
                label=_t("4x 过采样重建信号", "4x oversampled reconstruction"))
        ax.plot(t_seg, seg, "o", ms=4, color=COLORS["L_out"],
                label=_t("原始采样点", "original samples"))
        ax.axhline(ceil, color=COLORS["ceil"], ls="--", lw=1,
                   label=_t("上限", "ceiling"))
        ax.axhline(-ceil, color=COLORS["ceil"], ls="--", lw=1)
        ch_name = "L" if ch_idx == 0 else "R"
        ax.set_title(_t(f"重建峰检查（峰值附近，声道 {ch_name}）：采样点之间可能过冲",
                        f"True-peak check near max (ch {ch_name}): "
                        f"inter-sample overshoot possible"))
        ax.set_xlabel(_t("时间 (ms)", "time (ms)"))
        ax.set_ylabel(_t("幅度", "amplitude"))
        ax.legend(loc="upper right", fontsize=8)
        ax.grid(alpha=0.3)

        self.canvas.draw_idle()

    # ------------------------------------------------------------ 统计
    def _update_stats(self) -> None:
        x, res, fs = self.x, self.res, self.fs
        mono = x.ndim == 1
        sp_in = dsp.sample_peak(x)
        sp_out = dsp.sample_peak(res.y)
        tp_in = dsp.true_peak_levels(x, fs)
        tp_out = dsp.true_peak_levels(res.y, fs)
        ceil_db = dsp.to_dbfs(res.ceiling)
        names = ["(单声道)"] if mono else ["L", "R"]

        lines = [
            f"峰值上限 ceiling = {ceil_db:.3f} dBFS"
            + (f"（true-peak 保护已启用，迭代 {res.tp_guard_iters} 次）"
               if res.tp_guard_iters else ""),
            "",
            f"{'声道':<8}{'输入采样峰':>12}{'输出采样峰':>12}"
            f"{'输入重建峰':>12}{'输出重建峰':>12}",
        ]
        for i, nm in enumerate(names):
            lines.append(
                f"{nm:<8}{dsp.to_dbfs(sp_in[i]):>11.3f}dB"
                f"{dsp.to_dbfs(sp_out[i]):>11.3f}dB"
                f"{dsp.to_dbfs(tp_in[i]):>11.3f}dB"
                f"{dsp.to_dbfs(tp_out[i]):>11.3f}dB"
            )
        lines += [
            "",
            f"采样峰判定: {'全部不超线 ✓' if sp_out.max() <= res.ceiling + 1e-12 else '超线 ✗'}",
            f"重建峰判定: {'全部不超线 ✓' if tp_out.max() <= res.ceiling + 1e-9 else '超线 ✗（可勾选 true-peak 保护）'}",
        ]

        # 声像核对：联动时同一采样左右乘同一增益，逐采样 L/R 比例不变。
        if not mono:
            def energy_ratio(c: int) -> float:
                e_in = np.sum(x[:, c] ** 2)
                return np.sum(res.y[:, c] ** 2) / e_in if e_in > 0 else 1.0
            r_l, r_r = energy_ratio(0), energy_ratio(1)
            nz = np.max(np.abs(x), axis=1) > 1e-9
            ratio_in = x[nz, 0] / x[nz, 1]
            ratio_out = res.y[nz, 0] / res.y[nz, 1]
            pan_diff = float(np.max(np.abs(ratio_in - ratio_out)))
            lines += [
                "",
                "声像核对：",
                f"  能量保留比例  L = {r_l:.4f}    R = {r_r:.4f}（联动时本就不同，因素材内容不同）",
                f"  逐采样 L/R 比例最大偏差 = {pan_diff:.2e} → "
                + ("声像保持 ✓" if pan_diff < 1e-9
                   else "声像发生偏移（独立模式预期行为）"),
            ]

        # 等长 / 脉冲定位核对。
        lines += [
            "",
            f"长度: 输入 {x.shape[0]} 采样 → 输出 {res.y.shape[0]} 采样"
            f"（{'一致 ✓' if x.shape[0] == res.y.shape[0] else '不一致 ✗'}）",
        ]
        if self.source_meta.get("peaks_idx"):
            idxs = self.source_meta["peaks_idx"]
            # 立体声素材的尖峰打在 R 声道，单声道直接取整信号。
            sig_for_peak = res.y if mono else res.y[:, 1]
            out_peak = int(np.argmax(np.abs(sig_for_peak)))
            ok = out_peak in idxs
            lines.append(f"脉冲定位: 输入 {idxs} → 输出最大采样 {out_peak}"
                         f"（{'保持 ✓' if ok else '偏移 ✗'}）")

        self.stats_view.setText("\n".join(lines))

        self.latency_label.setText(
            f"算法等效延迟: {res.delay_samples} 采样 "
            f"({res.delay_samples / fs * 1000:.3f} ms)，"
            f"离线渲染已补偿：导出首尾时长与脉冲定位和输入一致。"
        )

    # ------------------------------------------------------------ 导出
    def export_wav(self) -> None:
        if not hasattr(self, "res"):
            return
        default = "limited_output.wav"
        if self.loaded_path:
            base = os.path.splitext(os.path.basename(self.loaded_path))[0]
            default = f"{base}_limited.wav"
        path, _ = QFileDialog.getSaveFileName(
            self, "导出限幅后 WAV", default, "WAV (*.wav)")
        if not path:
            return
        subtype = "FLOAT" if self.fmt_combo.currentIndex() == 0 else "PCM_16"
        try:
            wavio.write_wav(path, self.res.y, self.fs, subtype=subtype)
            # 回读验证导出文件本身不超线。
            xr, fsr = wavio.read_wav(path)
            sp = dsp.sample_peak(xr)
            tp = dsp.true_peak_levels(xr, fsr)
            ok_sp = sp.max() <= self.res.ceiling + 1e-9
            ok_tp = tp.max() <= self.res.ceiling + 1e-9 \
                if self.tp_chk.isChecked() else True
            msg = (f"已导出: {path}\n\n"
                   f"回读采样峰: {dsp.to_dbfs(sp.max()):.3f} dBFS "
                   f"({'不超线 ✓' if ok_sp else '超线 ✗'})\n"
                   f"回读重建峰: {dsp.to_dbfs(tp.max()):.3f} dBFS "
                   f"({'不超线 ✓' if ok_tp else '超线'})")
            QMessageBox.information(self, "导出完成并回读验证", msg)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "导出失败", str(exc))


def main() -> int:
    app = QApplication.instance() or QApplication([])
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
