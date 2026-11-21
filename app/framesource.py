"""按帧序号取帧: 维护一个 ffmpeg 顺序解码进程 + 帧缓存.

ffmpeg 的 select=eq(n,N) 滤镜按解码顺序数帧, 与「从第一帧数起的帧序号」
定义一致, 不依赖容器时间戳, 因此对 25fps 和 30000/1001 都同样可靠.
向前单步直接读流; 向后或大幅跳转时重启解码从头数 (短片核对场景可接受).
"""
from __future__ import annotations

import subprocess
from collections import OrderedDict

from .media import MediaInfo

_CACHE_LIMIT = 600  # 内存里最多保留的帧数


class FrameSource:
    def __init__(self, info: MediaInfo):
        self.info = info
        self.frame_size = info.width * info.height * 3  # rgb24
        self._proc: subprocess.Popen | None = None
        self._next_index = 0  # 解码进程下一帧的帧序号
        self._cache: OrderedDict[int, bytes] = OrderedDict()

    def close(self):
        self._kill()

    def _kill(self):
        if self._proc is not None:
            try:
                self._proc.kill()
                self._proc.wait(timeout=5)
            except Exception:
                pass
            self._proc = None

    def _start(self):
        self._kill()
        self._proc = subprocess.Popen(
            [
                "ffmpeg", "-v", "error",
                "-i", self.info.path,
                "-map", "0:v:0",
                "-f", "rawvideo",
                "-pix_fmt", "rgb24",
                "-",
            ],
            stdout=subprocess.PIPE,
            bufsize=10 ** 7,
        )
        self._next_index = 0

    def _read_exact(self, n: int) -> bytes | None:
        chunks = []
        remaining = n
        while remaining > 0:
            chunk = self._proc.stdout.read(remaining)
            if not chunk:
                return None
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def frame(self, index: int) -> bytes | None:
        """取第 index 帧 (0 起) 的 rgb24 数据; 超出片尾返回 None."""
        if index < 0:
            raise ValueError("帧序号不能为负")
        if index in self._cache:
            self._cache.move_to_end(index)
            return self._cache[index]
        if self._proc is None or index < self._next_index:
            self._start()
        while self._next_index <= index:
            data = self._read_exact(self.frame_size)
            if data is None:
                return None  # 片尾
            self._cache[self._next_index] = data
            self._next_index += 1
        # 淘汰最旧的帧, 控制内存
        while len(self._cache) > _CACHE_LIMIT:
            self._cache.popitem(last=False)
        return self._cache.get(index)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
