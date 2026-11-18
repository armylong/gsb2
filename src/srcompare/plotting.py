# -*- coding: utf-8 -*-
"""matplotlib 三路对比图: 每行一路(原声 / 线性 / 高质量), 左波形右频谱。

频谱频率坐标一律使用真实赫兹(Hz):
- 下采样时画出目标奈奎斯特线(目标可保留的最高频率)
- 低频通带区域绿色底纹, 超过奈奎斯特的高频区域红色底纹(折叠来源区)
- 测试音分量: 输入频率用实竖线标注, 折叠后位置用虚线红色标注
"""
from __future__ import annotations

import matplotlib

matplotlib.use("QtAgg")
from matplotlib import font_manager, rcParams
from matplotlib.figure import Figure
from matplotlib.backends.backend_qtagg import FigureCanvasQTAgg
from matplotlib.patches import Patch

import numpy as np

from .audioio import Track
from .spectrum import alias_frequency, psd_to_db, welch_spectrum

# 中文字体回退链: macOS 用 PingFang/Hiragino/Heiti, 其他系统回退 DejaVu
_AVAILABLE = {f.name for f in font_manager.fontManager.ttflist}
_CJK_CANDIDATES = [
    "PingFang SC", "Hiragino Sans GB", "Heiti SC", "STHeiti",
    "Arial Unicode MS", "Noto Sans CJK SC", "Microsoft YaHei",
]
_CJK = [n for n in _CJK_CANDIDATES if n in _AVAILABLE]
rcParams["font.sans-serif"] = _CJK + rcParams["font.sans-serif"]
rcParams["axes.unicode_minus"] = False

COLORS = {
    "original": "#2563eb",       # 蓝
    "linear": "#d97706",         # 琥珀
    "high_quality": "#059669",   # 绿
}
ROW_KEYS = ("original", "linear", "high_quality")
PASSBAND_SHADE = "#bbf7d0"
ALIAS_SHADE = "#fecaca"


class CompareCanvas(FigureCanvasQTAgg):
    """三路波形 + 频谱对比画布。"""

    def __init__(self, parent=None):
        self.figure = Figure(figsize=(11.5, 8.8))
        super().__init__(self.figure)
        self.setParent(parent)
        n_rows = 3
        self.axes_wave = [self.figure.add_subplot(n_rows, 2, 2 * i + 1) for i in range(n_rows)]
        self.axes_spec = [self.figure.add_subplot(n_rows, 2, 2 * i + 2) for i in range(n_rows)]
        self.figure.subplots_adjust(
            left=0.07, right=0.98, top=0.90, bottom=0.07, hspace=0.42, wspace=0.18
        )
        self._draw_placeholder()

    def _draw_placeholder(self):
        for ax in self.axes_wave + self.axes_spec:
            ax.text(
                0.5, 0.5, "载入 WAV 或生成测试音后显示",
                ha="center", va="center", transform=ax.transAxes, fontsize=11,
            )
            ax.set_xticks([])
            ax.set_yticks([])
        self.draw_idle()

    def update_plots(self, tracks: dict, channel: int = 0) -> None:
        """tracks: {'original': Track, 'linear': Track, 'high_quality': Track}"""
        self.figure.clear()
        n_rows = 3
        self.axes_wave = [self.figure.add_subplot(n_rows, 2, 2 * i + 1) for i in range(n_rows)]
        self.axes_spec = [self.figure.add_subplot(n_rows, 2, 2 * i + 2) for i in range(n_rows)]

        max_sr = max(t.sr for t in tracks.values())
        f_view_max = max_sr / 2.0
        db_limits: list[float] = []
        # 波形最多画这么多点, 过密时抽稀但保留波形细节
        wave_cap = 12000
        # 列标题
        self.figure.text(0.29, 0.965, "波形 (时间轴: 秒)", ha="center", fontsize=12)
        self.figure.text(0.73, 0.965, "频谱 — 真实频率 (Hz)", ha="center", fontsize=12)

        for row, key in enumerate(ROW_KEYS):
            tr: Track = tracks[key]
            color = COLORS[key]
            ax_w = self.axes_wave[row]
            ax_s = self.axes_spec[row]

            # ---------- 波形(过密时抽稀) ----------
            x = tr.mono(channel)
            step = max(1, tr.num_frames // wave_cap)
            xs = x[::step]
            t_axis = np.arange(len(xs)) * step / float(tr.sr)
            ax_w.plot(t_axis, xs, color=color, linewidth=0.7)
            ax_w.set_ylim(-1.05, 1.05)
            ax_w.set_xlim(0, tr.duration)
            ax_w.set_ylabel("幅度")
            ax_w.text(
                0.01, 0.97,
                f"{tr.name}\n实际 {tr.sr} Hz | {tr.num_frames} 点 | "
                f"{tr.duration:.4f}s | {tr.channels}ch | {tr.note}",
                transform=ax_w.transAxes, ha="left", va="top", fontsize=8.5,
                bbox=dict(boxstyle="round,pad=0.3", fc="white", ec=color, alpha=0.85),
            )
            if row == n_rows - 1:
                ax_w.set_xlabel("时间 (秒)")
            ax_w.grid(alpha=0.3)

            # ---------- 频谱 ----------
            freqs, psd = welch_spectrum(x, tr.sr)
            db = psd_to_db(psd)
            db_limits.append(float(np.max(db)))
            ax_s.plot(freqs, db, color=color, linewidth=0.9)
            ax_s.set_xlim(0, f_view_max)
            ax_s.set_ylabel("PSD (dB)")
            if row == n_rows - 1:
                ax_s.set_xlabel("频率 (Hz)")
            ax_s.grid(alpha=0.3)

            target_fn = tr.sr / 2.0
            if tr.sr < max_sr:
                # 下采样: 标出目标可保留的最高频率与两个区域
                ax_s.axvspan(0, target_fn, color=PASSBAND_SHADE, alpha=0.45, zorder=0)
                ax_s.axvspan(target_fn, f_view_max, color=ALIAS_SHADE, alpha=0.45, zorder=0)
                ax_s.axvline(
                    target_fn, color="#b91c1c", linestyle="--", linewidth=1.4, zorder=3,
                )
                ax_s.text(
                    target_fn, 1.02,
                    f"目标奈奎斯特 {target_fn:g}Hz (可保留最高频率)",
                    transform=ax_s.get_xaxis_transform(),
                    ha="center", va="bottom", fontsize=8.5, color="#b91c1c",
                    clip_on=False,
                )

            # 测试音: 输入频率位置(实线) 与折叠后位置(红色虚线)
            for n_alias, spec in enumerate(tr.tone_specs):
                if channel not in spec.channels:
                    continue
                if spec.freq <= f_view_max:
                    ax_s.axvline(spec.freq, color="#374151", linewidth=0.9, alpha=0.8)
                if spec.freq > target_fn:
                    f_alias = alias_frequency(spec.freq, tr.sr)
                    ax_s.axvline(
                        f_alias, color="#dc2626", linestyle=":", linewidth=1.6, zorder=4,
                    )
                    ax_s.annotate(
                        f"{spec.freq:g}Hz 折回 {f_alias:g}Hz",
                        xy=(f_alias, 0.78 - 0.14 * n_alias),
                        xycoords=ax_s.get_xaxis_transform(),
                        xytext=(8, 0), textcoords="offset points",
                        fontsize=8.5, color="#dc2626", va="top",
                    )

        # 频谱纵轴统一范围, 便于三路直接比较
        top = max(db_limits) + 6
        for ax_s in self.axes_spec:
            ax_s.set_ylim(top - 100, top)

        # 图例
        legend_items = [
            Patch(facecolor=PASSBAND_SHADE, label="通带: 应保留的低频"),
            Patch(facecolor=ALIAS_SHADE, label="高频区: 下采样中折叠/丢失的成分"),
        ]
        self.axes_spec[0].legend(
            handles=legend_items, loc="upper right", fontsize=8, framealpha=0.9
        )
        self.draw_idle()
