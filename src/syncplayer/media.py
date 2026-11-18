"""ffmpeg / ffprobe 封装: 探测、逐帧解码、音频解码。

设计要点:
- 帧 PTS 表由 ffprobe 一次性导出, 选帧逻辑只信这张表(见 timings.py)。
- 每个视频持有一个长驻 ffmpeg rawvideo 进程, 顺序读取; 向后跳时用
  输入 seek(-ss 在 -i 之前, ffmpeg 精确 seek)重启进程, 不做独立时钟。
- 解码在独立 QThread 中进行, UI 只发请求索引、收 QImage, 不阻塞界面。
"""
from __future__ import annotations

import collections
import json
import os
import subprocess

import numpy as np
from PySide6.QtCore import QObject, QThread, Qt, Signal, Slot
from PySide6.QtGui import QImage

from .timings import VideoInfo

FFMPEG = os.environ.get("FFMPEG_BIN", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE_BIN", "ffprobe")

FRAME_CACHE_SIZE = 90


class MediaError(RuntimeError):
    """媒体文件无法打开或解码时抛出。"""


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            cmd, capture_output=True, check=True, timeout=60
        )
    except FileNotFoundError as exc:
        raise MediaError(f"找不到可执行文件: {cmd[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise MediaError(f"命令超时: {' '.join(cmd)}") from exc
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.decode("utf-8", "replace").strip()
        raise MediaError(
            f"命令失败: {' '.join(cmd)}\n{detail[-500:]}"
        ) from exc


def file_identity(path: str) -> dict:
    """文件身份信息, 用于重载设置时确认还是原来的文件(绝不替换成别的文件)。"""
    st = os.stat(path)
    return {"size": st.st_size, "mtime": int(st.st_mtime)}


def probe_video(path: str) -> VideoInfo:
    """探测视频并导出逐帧 PTS 表。"""
    if not os.path.isfile(path):
        raise MediaError(f"文件不存在: {path}")

    meta_cmd = [
        FFPROBE, "-v", "error", "-show_streams", "-show_format",
        "-of", "json", path,
    ]
    meta = json.loads(_run(meta_cmd).stdout or b"{}")
    streams = meta.get("streams", [])
    video_streams = [s for s in streams if s.get("codec_type") == "video"]
    if not video_streams:
        raise MediaError(f"没有视频流: {path}")
    vs = video_streams[0]

    width = int(vs["width"])
    height = int(vs["height"])

    def _parse_duration() -> float:
        for src in (vs, meta.get("format", {})):
            raw = src.get("duration")
            if raw not in (None, "N/A"):
                return float(raw)
        return 0.0

    duration = _parse_duration()

    nominal: float | None = None
    rate = vs.get("r_frame_rate", "0/0")
    try:
        num, den = rate.split("/")
        if float(den) != 0:
            nominal = float(num) / float(den)
    except (ValueError, ZeroDivisionError):
        nominal = None

    # 逐帧 PTS(会真正解码一遍, 15s 片段成本可忽略)
    pts_cmd = [
        FFPROBE, "-v", "error", "-select_streams", "v:0",
        "-show_entries", "frame=pts_time", "-of", "csv=p=0", path,
    ]
    lines = _run(pts_cmd).stdout.decode("utf-8", "replace").splitlines()
    pts: list[float] = []
    fallback = 0.0
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            pts.append(float(line))
        except ValueError:
            # 个别封装首帧缺 pts_time, 用标称帧率补
            if nominal:
                pts.append(fallback)
                fallback += 1.0 / nominal
    if not pts:
        raise MediaError(f"无法导出任何帧时间: {path}")
    if duration <= 0.0:
        duration = pts[-1] + (
            (pts[-1] - pts[0]) / (len(pts) - 1) if len(pts) > 1 else 1.0
        )

    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    return VideoInfo(
        path=os.path.abspath(path),
        width=width,
        height=height,
        duration=duration,
        pts=tuple(pts),
        has_audio=has_audio,
        frame_rate_nominal=nominal,
    )


class _RawDecoder:
    """长驻 ffmpeg rawvideo 进程; 顺序读帧, 向后跳则精确 seek 重启。"""

    def __init__(self, info: VideoInfo):
        self.info = info
        self._proc: subprocess.Popen | None = None
        self._cursor = 0  # 下一次读出的帧对应的索引
        self._frame_bytes = info.width * info.height * 3
        self._cache: collections.OrderedDict[int, QImage] = collections.OrderedDict()

    def close(self) -> None:
        self._stop_proc()

    def _stop_proc(self) -> None:
        if self._proc is not None:
            try:
                self._proc.kill()
                self._proc.wait(timeout=3)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                pass
            self._proc = None

    def _start(self, seek_index: int) -> None:
        self._stop_proc()
        cmd = [FFMPEG, "-hide_banner", "-loglevel", "error"]
        if seek_index > 0:
            # 精确输入 seek: 输出首帧即 seek 目标帧
            cmd += ["-ss", f"{self.info.pts[seek_index]:.6f}"]
        cmd += [
            "-i", self.info.path,
            "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ]
        self._proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            bufsize=self._frame_bytes * 2,
        )
        self._cursor = seek_index

    def _read_one(self) -> QImage | None:
        assert self._proc is not None and self._proc.stdout is not None
        chunks: list[bytes] = []
        remaining = self._frame_bytes
        while remaining:
            chunk = self._proc.stdout.read(remaining)
            if not chunk:
                return None
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        img = QImage(
            raw, self.info.width, self.info.height,
            self.info.width * 3, QImage.Format.Format_RGB888,
        ).copy()  # copy 脱离临时缓冲
        return img

    def get_frame(self, index: int) -> QImage | None:
        """返回指定索引帧; 越界/EOF 返回 None。"""
        if index < 0 or index >= len(self.info.pts):
            return None
        if index in self._cache:
            self._cache.move_to_end(index)
            return self._cache[index]

        if self._proc is None or index < self._cursor:
            self._start(max(0, index))

        while self._cursor <= index:
            img = self._read_one()
            if img is None:
                # 读到 EOF: 后续请求需要重新 seek
                self._stop_proc()
                return None
            cur = self._cursor
            self._cache[cur] = img
            self._cache.move_to_end(cur)
            self._cursor += 1
            while len(self._cache) > FRAME_CACHE_SIZE:
                self._cache.popitem(last=False)

        return self._cache.get(index)


class DecoderWorker(QObject):
    """驻留在独立线程的解码服务, 合并过期请求。"""

    frameReady = Signal(int, object)  # index, QImage | None

    def __init__(self, info: VideoInfo):
        super().__init__()
        self._decoder = _RawDecoder(info)
        self._wanted: int | None = None
        self._served = -1

    @Slot(int)
    def request_frame(self, index: int) -> None:
        self._wanted = index
        # 一次唤醒期间把最新请求服务掉, 期间又更新的请求紧接着再服务
        while self._wanted is not None:
            wanted = self._wanted
            if wanted == self._served:
                self._wanted = None
                break
            img = self._decoder.get_frame(wanted)
            self._served = wanted
            self._wanted = None if self._wanted == wanted else self._wanted
            self.frameReady.emit(wanted, img)

    @Slot()
    def shutdown(self) -> None:
        self._decoder.close()


class DecoderService(QObject):
    """UI 侧句柄: 一个 worker + 一个线程, 通过信号跨线程投递请求。"""

    requestSignal = Signal(int)

    def __init__(self, info: VideoInfo):
        super().__init__()
        self.info = info
        self.thread = QThread()
        self.worker = DecoderWorker(info)
        self.worker.moveToThread(self.thread)
        self.requestSignal.connect(
            self.worker.request_frame, Qt.ConnectionType.QueuedConnection
        )
        self.thread.start()

    @property
    def frameReady(self) -> Signal:
        # UI 直接连接 worker 的结果信号(跨线程默认排队连接)
        return self.worker.frameReady

    def request(self, index: int) -> None:
        # 连续快速发请求时, worker 每轮只处理最新一个, 自动丢弃过期请求
        self.requestSignal.emit(index)

    def shutdown(self) -> None:
        from PySide6.QtCore import QMetaObject

        # 先在 worker 线程内关掉 ffmpeg 进程, 再停事件循环
        QMetaObject.invokeMethod(
            self.worker, "shutdown",
            Qt.ConnectionType.BlockingQueuedConnection,
        )
        self.thread.quit()
        self.thread.wait(3000)


class AudioBuffer:
    """整段解码后的 PCM(f32le, 立体声, 48kHz), 15s 数据量很小。"""

    TARGET_RATE = 48000

    def __init__(self, pcm: np.ndarray, sample_rate: int, channels: int):
        self.pcm = pcm  # float32, shape=(frames, channels)
        self.sample_rate = sample_rate
        self.channels = channels

    @property
    def duration(self) -> float:
        return self.pcm.shape[0] / self.sample_rate

    def segment_bytes(self, start: float, end: float) -> bytes:
        lo = max(0, int(start * self.sample_rate))
        hi = min(self.pcm.shape[0], int(end * self.sample_rate))
        if hi <= lo:
            return b""
        return self.pcm[lo:hi].tobytes()


def decode_audio(path: str) -> AudioBuffer | None:
    """把整段音频解码为 f32le 立体声 48kHz; 无音频流返回 None。"""
    probe = json.loads(
        _run([
            FFPROBE, "-v", "error", "-show_streams", "-of", "json", path,
        ]).stdout or b"{}"
    )
    if not any(s.get("codec_type") == "audio" for s in probe.get("streams", [])):
        return None
    proc = _run([
        FFMPEG, "-hide_banner", "-loglevel", "error",
        "-i", path, "-vn", "-ac", "2", "-ar", str(AudioBuffer.TARGET_RATE),
        "-f", "f32le", "-",
    ])
    pcm = np.frombuffer(proc.stdout, dtype=np.float32)
    if pcm.size == 0:
        return None
    return AudioBuffer(
        pcm.reshape(-1, 2).copy(), AudioBuffer.TARGET_RATE, 2
    )
