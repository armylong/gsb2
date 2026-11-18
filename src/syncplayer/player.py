"""主时钟播放引擎与偏移设置持久化。

两个画面共用同一个主时钟 t(A 片内容时间), 不存在两个独立播放器,
因此不会产生各自计时导致的持续漂移; 每次刷新都按同一 t 重新选帧。
"""
from __future__ import annotations

import json
import os

from PySide6.QtCore import QElapsedTimer, QObject, Qt, QTimer, Signal

from .timings import overlap_interval, wrap_into

TICK_MS = 16


class PlayerEngine(QObject):
    timeChanged = Signal(float)          # 主时间(每次刷新都发)
    stateChanged = Signal(bool)          # is_playing
    endReached = Signal()

    def __init__(self, info_a, info_b, parent=None):
        super().__init__(parent)
        self.info_a = info_a
        self.info_b = info_b
        self.offset = 0.0
        self.base_time = 0.0
        self.loop_enabled = False
        self._playing = False

        self._wall = QElapsedTimer()
        self._timer = QTimer(self)
        self._timer.setTimerType(Qt.TimerType.PreciseTimer)
        self._timer.setInterval(TICK_MS)
        self._timer.timeout.connect(self._tick)

    # ---------- 静态关系 ----------
    def overlap(self) -> tuple[float, float] | None:
        return overlap_interval(
            self.info_a.duration, self.info_b.duration, self.offset
        )

    def set_offset(self, offset: float) -> None:
        self.offset = float(offset)

    # ---------- 播放状态 ----------
    @property
    def is_playing(self) -> bool:
        return self._playing

    def play(self) -> None:
        # 在 A 内容末端按播放: 回到起点(若有重叠区间则从重叠起点)
        if self.base_time >= self.info_a.duration - 1e-6:
            ov = self.overlap()
            self.base_time = ov[0] if (self.loop_enabled and ov) else 0.0
        self._wall.start()
        self._playing = True
        self._timer.start()
        self.stateChanged.emit(True)

    def pause(self) -> None:
        if self._playing:
            self.base_time = self.current_time()
            self._playing = False
            self._timer.stop()
            self.stateChanged.emit(False)

    def toggle(self) -> None:
        self.pause() if self._playing else self.play()

    def stop_at_end(self) -> None:
        self._playing = False
        self._timer.stop()
        self.base_time = self.info_a.duration
        self.stateChanged.emit(False)
        self.timeChanged.emit(self.base_time)
        self.endReached.emit()

    def seek(self, t: float) -> None:
        self.base_time = min(max(0.0, t), self.info_a.duration)
        if self._playing:
            self._wall.start()
        else:
            self.timeChanged.emit(self.base_time)

    def step_a(self, frames: int) -> None:
        """按 A 片帧间隔步进(共用控制, B 跟随同一主时钟)。"""
        pts = self.info_a.pts
        if len(pts) < 2:
            return
        step = self.info_a.avg_interval
        was_playing = self._playing
        self.pause()
        t = self.base_time + frames * step
        self.seek(min(max(t, 0.0), self.info_a.duration))
        if was_playing:
            self.play()

    def current_time(self) -> float:
        if not self._playing:
            return self.base_time
        t = self.base_time + self._wall.nsecsElapsed() / 1e9
        if self.loop_enabled:
            ov = self.overlap()
            if ov is not None and t >= ov[1]:
                # 折回并重置墙钟基准, 连续无缝循环
                t = wrap_into(t, ov[0], ov[1])
                self.base_time = t
                self._wall.start()
        elif t >= self.info_a.duration:
            self.stop_at_end()
            return self.base_time
        return t

    def _tick(self) -> None:
        self.timeChanged.emit(self.current_time())

    def shutdown(self) -> None:
        self._timer.stop()


# ---------- 偏移设置保存 / 载入 ----------

SETTINGS_VERSION = 1


def default_settings_path(path_a: str, path_b: str) -> str:
    import hashlib

    h = hashlib.sha1(
        f"{os.path.abspath(path_a)}|{os.path.abspath(path_b)}".encode("utf-8")
    ).hexdigest()[:10]
    base = os.path.join(os.path.expanduser("~"), ".syncplayer")
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, f"offset_{h}.json")


def build_settings(path_a, path_b, id_a, id_b, offset: float) -> dict:
    return {
        "version": SETTINGS_VERSION,
        "video_a": {"path": os.path.abspath(path_a), **id_a},
        "video_b": {"path": os.path.abspath(path_b), **id_b},
        "offset_seconds": offset,
        "convention": "b_content_time = master_time(a) + offset",
    }


def save_settings(path: str, payload: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def load_settings(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if data.get("version") != SETTINGS_VERSION:
        raise ValueError("设置文件版本不支持")
    for key in ("video_a", "video_b", "offset_seconds"):
        if key not in data:
            raise ValueError(f"设置文件缺少字段: {key}")
    return data


def verify_identity(entry: dict) -> bool:
    """路径存在且 size/mtime 与保存时一致, 才认定是原来的文件。"""
    path = entry.get("path", "")
    if not os.path.isfile(path):
        return False
    try:
        st = os.stat(path)
    except OSError:
        return False
    return (
        st.st_size == entry.get("size")
        and int(st.st_mtime) == entry.get("mtime")
    )
