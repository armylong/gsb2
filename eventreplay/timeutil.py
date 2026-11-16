"""时间解析与窗口对齐工具.

所有业务时间在库内统一为 UTC ISO8601 字符串(秒级), 窗口按固定大小
从 epoch 对齐, 保证边界稳定、与事件到达顺序无关。
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

ISO = "iso"
EPOCH = "epoch"
EPOCH_MS = "epoch_ms"


def to_iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(value, formats) -> str:
    """按配置的格式列表依次尝试解析时间, 返回 UTC ISO 字符串.

    支持的格式: "iso" / "epoch" / "epoch_ms" / 任意 strftime 格式串。
    解析失败抛出 ValueError。
    """
    if value is None:
        raise ValueError("时间为空")
    text = str(value).strip()
    if not text:
        raise ValueError("时间为空")
    errors = []
    for fmt in formats:
        try:
            if fmt == ISO:
                dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
                return to_iso(dt)
            if fmt == EPOCH:
                return to_iso(datetime.fromtimestamp(float(text), tz=timezone.utc))
            if fmt == EPOCH_MS:
                return to_iso(datetime.fromtimestamp(float(text) / 1000.0, tz=timezone.utc))
            dt = datetime.strptime(text, fmt)
            return to_iso(dt)
        except (ValueError, OverflowError) as exc:  # 尝试下一种格式
            errors.append(f"{fmt}: {exc}")
    raise ValueError(f"无法解析时间 {text!r} ({'; '.join(errors)})")


def iso_to_epoch(iso_text: str) -> int:
    dt = datetime.fromisoformat(iso_text.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


_WINDOW_RE = re.compile(r"^(\d+)([smhd])$")
_UNIT_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def window_size_seconds(spec: str) -> int:
    """解析窗口规格, 如 '15m' / '1h' / '1d'。"""
    m = _WINDOW_RE.match(spec.strip())
    if not m:
        raise ValueError(f"非法窗口规格: {spec!r}, 应形如 15m/1h/1d")
    return int(m.group(1)) * _UNIT_SECONDS[m.group(2)]


def window_start_for(iso_text: str, size_seconds: int) -> str:
    """返回某业务时间所属窗口的起始时刻(对齐到固定边界)。"""
    epoch = iso_to_epoch(iso_text)
    start = (epoch // size_seconds) * size_seconds
    return to_iso(datetime.fromtimestamp(start, tz=timezone.utc))


def window_end_for(window_start_iso: str, size_seconds: int) -> str:
    start = iso_to_epoch(window_start_iso)
    return to_iso(datetime.fromtimestamp(start + size_seconds, tz=timezone.utc))


def day_floor(iso_or_date: str) -> str:
    """把日期或时间字符串归一到当天 00:00:00Z。"""
    text = iso_or_date.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return text + "T00:00:00Z"
    return to_iso(datetime.fromisoformat(text.replace("Z", "+00:00")))


def day_ceiling(iso_or_date: str) -> str:
    """把日期或时间字符串归一到次日 00:00:00Z(作为右开边界)。"""
    start = iso_to_epoch(day_floor(iso_or_date))
    return to_iso(datetime.fromtimestamp(start + 86400, tz=timezone.utc))
