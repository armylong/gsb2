"""双音多频 (DTMF) 键盘表与双频合成.

频率取自旧式展览按键音常见的双频组: 低频组 697/770/852/941 Hz,
高频组 1209/1336/1477/1633 Hz. 每个键由"低组中的一个音 + 高组中的一个音"
同时发声组成, 两者等长、不必等强.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

LOW_GROUP = (697.0, 770.0, 852.0, 941.0)
HIGH_GROUP = (1209.0, 1336.0, 1477.0, 1633.0)

_KEY_GRID = (
    ("1", "2", "3", "A"),
    ("4", "5", "6", "B"),
    ("7", "8", "9", "C"),
    ("*", "0", "#", "D"),
)

KEYPAD: dict[str, tuple[float, float]] = {}
for _row, _low in enumerate(LOW_GROUP):
    for _col, _high in enumerate(HIGH_GROUP):
        KEYPAD[_KEY_GRID[_row][_col]] = (_low, _high)

# 键位按键盘顺序展示时用的固定顺序
KEY_ORDER = "123A456B789C*0#D"

# 每个键在低/高组中的索引, 用于快速反查
LOW_INDEX = {int(round(f)): i for i, f in enumerate(LOW_GROUP)}
HIGH_INDEX = {int(round(f)): i for i, f in enumerate(HIGH_GROUP)}


def key_for_group_indices(low_idx: int, high_idx: int) -> str:
    return _KEY_GRID[low_idx][high_idx]


def group_indices_for_key(key: str) -> tuple[int, int]:
    low, high = KEYPAD[key]
    return LOW_INDEX[int(round(low))], HIGH_INDEX[int(round(high))]


def normalize_key_input(text: str) -> str:
    """把用户随手输入的字符串清洗成合法的键序列.

    允许空格/逗号/竖线等分隔符任意混用, 字母统一转大写. 非法字符直接报错,
    这样不会悄悄丢掉用户以为按键成功的字符.
    """
    allowed = set(KEYPAD)
    out: list[str] = []
    for ch in text:
        upper = ch.upper()
        if upper in allowed:
            out.append(upper)
        elif ch in " \t\r\n,，;；|/\\-":
            continue
        else:
            raise ValueError(f"不认识的键位: {ch!r}")
    return "".join(out)


@dataclass(frozen=True)
class SynthSettings:
    """一条合成 wav 的参数.

    low_gain / high_gain 分别控制低组、高组音的振幅; 两个值可以在界面上分开调,
    用来演示"两支音强弱差很大"时检测是否还能成立.
    key_ms 为每个键的持续时长, gap_ms 为相邻键之间的静音.
    """

    sample_rate: int = 8000
    low_gain: float = 0.5
    high_gain: float = 0.5
    key_ms: int = 90
    gap_ms: int = 70
    lead_ms: int = 300
    tail_ms: int = 300
    noise_level: float = 0.0
    seed: int = 7
    fade_ms: float = 4.0

    def validate(self) -> None:
        if not 4000 <= self.sample_rate <= 192000:
            raise ValueError("采样率需在 4000~192000 之间")
        if self.key_ms < 10:
            raise ValueError("键音持续时间至少要 10 毫秒")
        if self.gap_ms < 0:
            raise ValueError("键间空白不能是负数")
        for name, value in (("低频组强弱", self.low_gain), ("高频组强弱", self.high_gain)):
            if not 0.0 <= value <= 1.0:
                raise ValueError(f"{name}需在 0~1 之间")
        if self.noise_level < 0:
            raise ValueError("背景声不能是负数")


@dataclass(frozen=True)
class ToneOverride:
    """单个键的偏差设定, 用来做"轻微频差 / 缺一支音 / 强弱差很大 / 单键过短"的对照样音.

    所有字段都是相对该键标称值而言的; drop_low / drop_high 用来故意去掉一支音,
    key_ms 用来单独改某个键的时长 (做"短键混在正常键里"的场景).
    """

    low_offset_hz: float = 0.0
    high_offset_hz: float = 0.0
    low_gain: float | None = None
    high_gain: float | None = None
    key_ms: float | None = None
    gap_after_ms: float | None = None
    drop_low: bool = False
    drop_high: bool = False


@dataclass
class SynthResult:
    samples: np.ndarray
    sample_rate: int
    keys: str
    segments: list[tuple[str, float, float]] = field(default_factory=list)

    @property
    def duration(self) -> float:
        return len(self.samples) / self.sample_rate


def _tone_burst(key: str, settings: SynthSettings, override: ToneOverride | None = None) -> np.ndarray:
    low, high = KEYPAD[key]
    low_gain = settings.low_gain if override is None or override.low_gain is None else override.low_gain
    high_gain = settings.high_gain if override is None or override.high_gain is None else override.high_gain
    key_ms = settings.key_ms if override is None or override.key_ms is None else override.key_ms
    if override is not None:
        low += override.low_offset_hz
        high += override.high_offset_hz
        if override.drop_low:
            low_gain = 0.0
        if override.drop_high:
            high_gain = 0.0
    n = int(round(settings.sample_rate * key_ms / 1000.0))
    if n <= 0:
        raise ValueError(f"键 {key!r} 的时长过短")
    t = np.arange(n) / settings.sample_rate
    # 归一化: 两组振幅之和不超过 1, 留 0.9 的余量避免削顶
    total = max(low_gain + high_gain, 1e-9)
    scale = 0.9 / total
    wave = (
        low_gain * scale * np.sin(2 * np.pi * low * t)
        + high_gain * scale * np.sin(2 * np.pi * high * t)
    )
    fade_n = min(int(round(settings.sample_rate * settings.fade_ms / 1000.0)), n // 2)
    if fade_n > 1:
        ramp = 0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, fade_n))
        wave[:fade_n] *= ramp
        wave[-fade_n:] *= ramp[::-1]
    return wave.astype(np.float64)


@dataclass(frozen=True)
class SegmentPlan:
    """合成计划里的一段: 一个键或一段静音."""

    kind: str  # "key" | "gap"
    key: str = ""
    ms: float = 0.0
    override: ToneOverride | None = None


def plan_for(
    keys: str, settings: SynthSettings, overrides: list[ToneOverride] | None = None
) -> list[SegmentPlan]:
    """把键序列展开成"键-空白-键-空白"的段落计划, 界面和合成共用."""
    plan: list[SegmentPlan] = []
    for i, key in enumerate(keys):
        override = overrides[i] if overrides is not None else None
        key_ms = settings.key_ms if override is None or override.key_ms is None else override.key_ms
        plan.append(SegmentPlan(kind="key", key=key, ms=key_ms, override=override))
        if i != len(keys) - 1:
            gap_ms = settings.gap_ms if override is None or override.gap_after_ms is None else override.gap_after_ms
            if gap_ms > 0:
                plan.append(SegmentPlan(kind="gap", ms=gap_ms))
    return plan


def synthesize(
    keys: str,
    settings: SynthSettings,
    overrides: list[ToneOverride] | None = None,
) -> SynthResult:
    """把键序列合成成一条带停顿的单声道 wav 数据.

    overrides 与 keys 等长时逐键生效, 用来制造偏频/缺音/单边过弱/单个键过短的对照样音.
    """
    settings.validate()
    keys = normalize_key_input(keys)
    if not keys:
        raise ValueError("至少需要输入一个键")
    if overrides is not None and len(overrides) != len(keys):
        raise ValueError("逐键偏差的数量必须和键的数量一致")
    sr = settings.sample_rate
    lead_n = int(round(sr * settings.lead_ms / 1000.0))
    tail_n = int(round(sr * settings.tail_ms / 1000.0))

    pieces: list[np.ndarray] = [np.zeros(lead_n, dtype=np.float64)]
    segments: list[tuple[str, float, float]] = []
    cursor = lead_n
    for item in plan_for(keys, settings, overrides):
        if item.kind == "gap":
            n = int(round(sr * item.ms / 1000.0))
            pieces.append(np.zeros(n, dtype=np.float64))
            cursor += n
            continue
        burst = _tone_burst(item.key, settings, item.override)
        pieces.append(burst)
        start = cursor / sr
        cursor += len(burst)
        end = cursor / sr
        segments.append((item.key, start, end))
    pieces.append(np.zeros(tail_n, dtype=np.float64))
    data = np.concatenate(pieces)

    if settings.noise_level > 0:
        rng = np.random.default_rng(settings.seed)
        noise = rng.standard_normal(len(data))
        # 背景声按全段能量给一个相对水平, 这样静音段也能看到底噪
        data = data + settings.noise_level * 0.25 * noise

    # 保险: 整体压在 0.999 以下
    peak = float(np.max(np.abs(data))) if len(data) else 0.0
    if peak > 0.999:
        data = data * (0.999 / peak)

    return SynthResult(samples=data.astype(np.float32), sample_rate=sr, keys=keys, segments=segments)
