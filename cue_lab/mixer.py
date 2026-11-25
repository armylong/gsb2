"""混音引擎与工程状态。

关键约定 (对应需求 4):
- 所有声源先按各自的开始时刻放进一条统一时间轴, 再施加增益;
- 增益只改幅度, 永不挪动采样位置;
- 试听区间只是时间轴上的一个观察窗口, 提示音超出窗口时仍按原时刻
  混入与窗口相交的部分, 不会被截断重排。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

MAX_CUES = 3
MODE_MIX = "mix"
MODE_BG = "bg"
MODE_CUE = "cue"  # 只听当前选中的那一路提示音


def db_to_lin(db: float) -> float:
    return float(10.0 ** (db / 20.0))


def lin_to_db(lin: float) -> float:
    return float(20.0 * np.log10(max(lin, 1e-9)))


@dataclass
class CueState:
    name: str
    audio: np.ndarray
    start: float = 1.0          # 在统一时间轴上的开始时刻 (秒)
    gain_db: float = 0.0

    def end_time(self, sr: int) -> float:
        return self.start + len(self.audio) / sr


@dataclass
class ProjectState:
    sr: int
    background: np.ndarray | None = None
    bg_gain_db: float = 0.0
    cues: list[CueState] = field(default_factory=list)
    # 测试区间 (整条时间轴上的比较范围)
    test_start: float = 0.0
    test_end: float = 6.0
    # 高亮试听短段
    seg_start: float = 0.8
    seg_dur: float = 2.0
    selected_band: int = 3
    current_cue: int = 0
    mode: str = MODE_MIX

    def total_duration(self) -> float:
        """时间轴总长: 至少覆盖背景与每一路提示音的末端。"""
        end = 0.0
        if self.background is not None and self.background.size:
            end = max(end, len(self.background) / self.sr)
        for cue in self.cues:
            end = max(end, cue.end_time(self.sr))
        # 留 0.25s 尾巴, 避免最后一个采样贴边
        return max(end + 0.25, self.test_end, 0.5)

    def total_samples(self) -> int:
        return int(round(self.total_duration() * self.sr))

    def seg_end(self) -> float:
        return self.seg_start + self.seg_dur

    def clamp_segment(self) -> None:
        """把试听短段夹在测试区间内。"""
        total = self.total_duration()
        self.test_end = min(max(self.test_end, self.test_start + 0.05), total)
        self.seg_dur = min(max(self.seg_dur, 0.05), self.test_end - self.test_start)
        self.seg_start = float(
            np.clip(self.seg_start, self.test_start, self.test_end - self.seg_dur)
        )
        n_band_guard = self.selected_band  # 频带编号由分析模块决定, 这里只做非负
        self.selected_band = max(0, n_band_guard)
        if self.cues:
            self.current_cue = min(max(self.current_cue, 0), len(self.cues) - 1)


def place_on_timeline(audio: np.ndarray, start_sec: float, total_n: int, sr: int) -> np.ndarray:
    """把一段音频按绝对开始时刻放到长度 total_n 的零数组里。

    超出时间轴右端的部分直接落在交集外, 由数组长度自然裁掉;
    start 为负时只保留 >=0 的交集样本, 时刻语义保持不变。
    """
    out = np.zeros(total_n, dtype=np.float64)
    i_start = int(round(start_sec * sr))
    i_end = i_start + len(audio)
    lo = max(0, i_start)
    hi = min(total_n, i_end)
    if hi > lo:
        out[lo:hi] = audio[lo - i_start: hi - i_start]
    return out


def background_stem(state: ProjectState) -> np.ndarray:
    n = state.total_samples()
    if state.background is None or state.background.size == 0:
        return np.zeros(n)
    g = db_to_lin(state.bg_gain_db)
    stem = place_on_timeline(state.background, 0.0, n, state.sr)
    return stem * g


def cue_stem(state: ProjectState, index: int) -> np.ndarray:
    n = state.total_samples()
    if index < 0 or index >= len(state.cues):
        return np.zeros(n)
    cue = state.cues[index]
    g = db_to_lin(cue.gain_db)
    # 注意: 先定位、后增益, start 与增益完全解耦
    return place_on_timeline(cue.audio, cue.start, n, state.sr) * g


def render_mode(state: ProjectState, mode: str) -> np.ndarray:
    """按给定监听模式渲染整条时间轴 (不是只渲染试听段)。"""
    n = state.total_samples()
    if mode == MODE_BG:
        return background_stem(state)
    if mode == MODE_CUE:
        if not state.cues:
            return np.zeros(n)
        return cue_stem(state, state.current_cue)
    # MODE_MIX: 背景 + 全部提示音
    y = background_stem(state)
    for i in range(len(state.cues)):
        y = y + cue_stem(state, i)
    return y


def render_current(state: ProjectState) -> np.ndarray:
    return render_mode(state, state.mode)


def segment_sample_range(state: ProjectState) -> tuple[int, int]:
    """试听短段对应的采样区间 (各模式共用, 保证切换模式位置不漂移)。"""
    i0 = int(round(state.seg_start * state.sr))
    i1 = int(round(state.seg_end() * state.sr))
    n = state.total_samples()
    return max(0, i0), min(n, max(i0 + 1, i1))


def test_sample_range(state: ProjectState) -> tuple[int, int]:
    i0 = int(round(state.test_start * state.sr))
    i1 = int(round(state.test_end * state.sr))
    n = state.total_samples()
    return max(0, i0), min(n, max(i0 + 1, i1))


def rms_db(x: np.ndarray) -> float:
    if x.size == 0:
        return -120.0
    return lin_to_db(float(np.sqrt(np.mean(x**2))))
