"""数据模型、编码常量与 JSON 读写.

设计约束
--------
* 计划(plan)只描述"原本应该在什么时刻出现什么标记"。
* 识别(analyze)完全不读取 plan, 只按画面编码和声音频率独立检出标记。
* 匹配(match)才把独立检出结果与 plan 对齐。
"""

from __future__ import annotations

import json
import math
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

# ---------------------------------------------------------------------------
# 编码方案常量 (生成器和识别器共享, 但识别器并不读取 plan)
# ---------------------------------------------------------------------------

SCHEMA_PLAN = "syncmark.plan/1"
SCHEMA_REPORT = "syncmark.report/1"

DEFAULT_FPS = 30
DEFAULT_WIDTH = 640
DEFAULT_HEIGHT = 360
DEFAULT_SAMPLE_RATE = 48_000

FLASH_FRAMES = 3            # 一个闪光持续 3 帧 (100 ms @30fps)
TONE_MS = 90                # 提示声音长 90 ms
LEAD_FRAMES = 15            # 默认第一段普通画面 0.5 s
TAIL_FRAMES = 30            # 结尾普通画面 1.0 s
DEFAULT_MARKER_COUNT = 12

# 每段普通画面的长度都不同, 覆盖 0.8 s ~ 2.0 s
GAP_PATTERN_FRAMES = [24, 39, 30, 51, 27, 45, 33, 60, 24, 42, 36, 54, 27, 48, 30, 45]

# 16 个彼此相隔 120 Hz 的音高, 用来区分 1..16 号标记
TONE_PALETTE_HZ = [420 + 120 * i for i in range(16)]
MAX_MARKERS = len(TONE_PALETTE_HZ)

DETECT_VIDEO_WIDTH = 192
DETECT_VIDEO_HEIGHT = 108
DETECT_CODE_BITS = 10       # 8 位编号 + 2 位校验

# 匹配与判定阈值
MATCH_WINDOW_S = 0.75       # 同一编号的检出与计划相距超过该值就不再配对
EVENT_TOL_S = 0.045         # 扣除整体偏移后, 单事件残差超过 45 ms 算个别事件问题
GLOBAL_MIN_S = 0.050        # 整体偏移至少 50 ms 才上报
GLOBAL_MAD_MAX_S = 0.035    # 整体偏移候选的离散度上限 (MAD)
GLOBAL_MIN_SUPPORT = 3


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def checksum2(marker_id: int) -> int:
    """10 位编码中的 2 位校验值."""
    return (marker_id * 7 + 5) & 0x3


def code_bits_for_id(marker_id: int) -> list[int]:
    """返回 10 个画面上从左到右的黑白块 (1=白, 0=黑)."""
    if not 1 <= marker_id <= 255:
        raise ValueError("marker id 必须为 1..255")
    bits = [(marker_id >> i) & 1 for i in range(8)]
    c = checksum2(marker_id)
    bits.extend([c & 1, (c >> 1) & 1])
    return bits


def id_from_code_bits(bits: list[int]) -> int | None:
    """从 10 位黑白块还原编号, 校验失败返回 None."""
    if len(bits) != DETECT_CODE_BITS:
        return None
    value = sum((bit & 1) << i for i, bit in enumerate(bits[:8]))
    c = (bits[8] & 1) | ((bits[9] & 1) << 1)
    if value < 1 or c != checksum2(value):
        return None
    return value


def tone_for_id(marker_id: int) -> float:
    if not 1 <= marker_id <= MAX_MARKERS:
        raise ValueError(f"marker id 必须为 1..{MAX_MARKERS}")
    return float(TONE_PALETTE_HZ[marker_id - 1])


def id_for_tone(freq_hz: float, tolerance_hz: float = 35.0) -> int | None:
    idx = min(range(len(TONE_PALETTE_HZ)), key=lambda i: abs(TONE_PALETTE_HZ[i] - freq_hz))
    if abs(TONE_PALETTE_HZ[idx] - freq_hz) <= tolerance_hz:
        return idx + 1
    return None


def build_timeline(marker_count: int, *, first_at_zero: bool = False) -> tuple[list[int], int]:
    """返回每个标记的起始帧号, 以及计划总帧数."""
    if not 1 <= marker_count <= MAX_MARKERS:
        raise ValueError(f"marker_count 必须为 1..{MAX_MARKERS}")
    lead = 0 if first_at_zero else LEAD_FRAMES
    starts: list[int] = []
    f = lead
    for i in range(marker_count):
        starts.append(f)
        gap = GAP_PATTERN_FRAMES[i % len(GAP_PATTERN_FRAMES)] if i < marker_count - 1 else TAIL_FRAMES
        f += FLASH_FRAMES + gap
    return starts, f


def make_plan(
    *,
    marker_count: int = DEFAULT_MARKER_COUNT,
    fps: int = DEFAULT_FPS,
    width: int = DEFAULT_WIDTH,
    height: int = DEFAULT_HEIGHT,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    first_at_zero: bool = False,
    faults: dict[str, Any] | None = None,
) -> dict[str, Any]:
    starts, total_frames = build_timeline(marker_count, first_at_zero=first_at_zero)
    markers = []
    for i, frame in enumerate(starts):
        marker_id = i + 1
        markers.append(
            {
                "id": marker_id,
                "number": marker_id,
                "frame": frame,
                "time": round(frame / fps, 6),
                "flash_frames": FLASH_FRAMES,
                "tone_hz": tone_for_id(marker_id),
                "gap_frames_after": (
                    GAP_PATTERN_FRAMES[i % len(GAP_PATTERN_FRAMES)]
                    if i < marker_count - 1
                    else TAIL_FRAMES
                ),
            }
        )
    return {
        "schema": SCHEMA_PLAN,
        "created_utc": now_utc(),
        "generator": {"name": "syncmark", "version": "1.0.0"},
        "video": {
            "width": width,
            "height": height,
            "fps": fps,
            "frames": total_frames,
            "duration": round(total_frames / fps, 6),
        },
        "audio": {
            "sample_rate": sample_rate,
            "channels": 1,
            "tone_ms": TONE_MS,
            "palette_hz": list(TONE_PALETTE_HZ),
        },
        "markers": markers,
        "faults": faults or {},
        "notes": [
            "markers 是原计划时刻; 测试片的缺损记录在 faults 中, 不改变计划时刻.",
            "识别阶段不读取本计划, 只从解码后的画面/声音独立检出.",
        ],
    }


def plan_default_path(film_path: str) -> str:
    root, _ = os.path.splitext(film_path)
    return root + ".plan.json"


def find_plan_sidecar(film_path: str) -> str | None:
    """查找短片旁边的计划文件, 兼容 <stem>.plan.json 与 <file>.plan.json."""
    candidates = [
        plan_default_path(film_path),
        film_path + ".plan.json",
        os.path.join(os.path.dirname(os.path.abspath(film_path)), "plan.json"),
    ]
    for p in candidates:
        if os.path.isfile(p):
            return p
    return None


def read_json(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def write_json_atomic(path: str, data: dict[str, Any]) -> None:
    parent = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".syncmark-", suffix=".json", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def fmt_sec(t: float | None, digits: int = 3) -> str:
    if t is None:
        return "-"
    if not math.isfinite(t):
        return "-"
    return f"{t:.{digits}f}s"


def fmt_ms(seconds: float | None) -> str:
    if seconds is None or not math.isfinite(seconds):
        return "-"
    return f"{seconds * 1000.0:+.1f} ms"


# ---------------------------------------------------------------------------
# 轻量数据结构 (仅用于内部传递, 对外统一写 dict/JSON)
# ---------------------------------------------------------------------------


@dataclass
class VideoDetection:
    id: int | None
    start_frame: int
    end_frame: int
    start_time: float
    end_time: float
    frame_count: int
    merged_runs: int = 1
    duplicate_frames: int = 0
    raw_code: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "start_frame": self.start_frame,
            "end_frame": self.end_frame,
            "start_time": round(self.start_time, 6),
            "end_time": round(self.end_time, 6),
            "frame_count": self.frame_count,
            "merged_runs": self.merged_runs,
            "duplicate_frames": self.duplicate_frames,
            "raw_code": self.raw_code,
        }


@dataclass
class AudioDetection:
    id: int | None
    freq_hz: float
    start_sample: int
    end_sample: int
    start_time: float
    end_time: float
    peak: float
    confidence: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "freq_hz": round(self.freq_hz, 2),
            "start_sample": self.start_sample,
            "end_sample": self.end_sample,
            "start_time": round(self.start_time, 6),
            "end_time": round(self.end_time, 6),
            "duration_ms": round((self.end_sample - self.start_sample) * 1000.0 / DEFAULT_SAMPLE_RATE, 2),
            "peak": round(self.peak, 4),
            "confidence": round(self.confidence, 3),
        }
