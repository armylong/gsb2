"""内置示例: 各配一条背景 + 三条候选提示音, 时刻刻意安排成
提示音前半段落在背景能量区、后半段落在背景安静区,
方便直接观察"前半被盖住、后半露出来"。
"""

from __future__ import annotations

from . import synth
from .mixer import CueState, ProjectState

SR = 22050


def build_intermittent_example() -> ProjectState:
    """间歇噪声背景: 0.45s 开 / 0.55s 关, 提示音 0.9s 横跨一个噪声团。"""
    bg = synth.intermittent_noise(SR, duration=6.0, f_low=400, f_high=900,
                                  on_ms=450, off_ms=550, seed=7)
    # 提示音从 0.55s 开始: 前 ~0.45s 与第二团噪声 (1.0-1.45s) 重叠,
    # 后半进入 1.45-2.0s 的安静间隔
    cues = [
        CueState("1.2k 单频", synth.tone_cue(SR, 0.9, 1200.0), start=0.55, gain_db=-6.0),
        CueState("880→1320 双音", synth.two_tone_cue(SR, 0.9, 880.0, 1320.0),
                 start=0.55, gain_db=-6.0),
        CueState("500→2.6k 扫频", synth.chirp_cue(SR, 0.9, 500.0, 2600.0),
                 start=0.55, gain_db=-6.0),
    ]
    state = ProjectState(
        sr=SR, background=bg, bg_gain_db=-4.0, cues=cues,
        test_start=0.0, test_end=4.0, seg_start=0.35, seg_dur=2.0,
        selected_band=3, current_cue=0,
    )
    state.clamp_segment()
    return state


def build_narrowband_example() -> ProjectState:
    """窄带嗡嗡声背景 (中心 2kHz): 带内提示音被掩蔽, 带外提示音露出来。"""
    bg = synth.narrowband_noise(SR, duration=6.0, center=2000.0, width=240.0,
                                am_hz=3.0, seed=23)
    # AM 周期 1/3s, 提示音 1.2s 可跨过强弱起伏;
    # 一路放在掩蔽带内 (2k), 两路放在带外做对照
    cues = [
        CueState("2.0k 带内单频", synth.tone_cue(SR, 1.2, 2000.0),
                 start=0.8, gain_db=-8.0),
        CueState("2.5k 窄带噪声", synth.narrowband_cue(SR, 1.0, 2500.0, 160.0),
                 start=0.9, gain_db=-6.0),
        CueState("3.2k 单频", synth.tone_cue(SR, 1.2, 3200.0),
                 start=0.8, gain_db=-8.0),
    ]
    state = ProjectState(
        sr=SR, background=bg, bg_gain_db=-2.0, cues=cues,
        test_start=0.0, test_end=4.0, seg_start=0.6, seg_dur=2.2,
        selected_band=4, current_cue=0,
    )
    state.clamp_segment()
    return state


EXAMPLES = {
    "间歇噪声示例 (提示音横跨噪声团与安静间隔)": build_intermittent_example,
    "窄带噪声示例 (带内掩蔽 vs 带外露出)": build_narrowband_example,
}
