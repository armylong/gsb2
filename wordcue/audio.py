"""音频解码、波形峰值与播放控制。

统一约定:
  * 任何音频进来后都先解码为 **48 kHz / 单声道 / s16le** 的 PCM;
  * 播放位置一律以毫秒表示, 与 ``model.Timeline`` 使用同一基准;
  * 波形、游标、字幕时间码全部基于同一个 ``AudioPlayer.position_ms``。
"""

from __future__ import annotations

import array
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass

from PySide6.QtCore import QByteArray, QBuffer, QIODevice, QObject, QTimer, Signal
from PySide6.QtMultimedia import QAudioFormat, QAudioSink, QMediaDevices

SAMPLE_RATE = 48_000
BYTES_PER_SAMPLE = 2


class AudioError(RuntimeError):
    pass


def find_ffmpeg(name: str = "ffmpeg") -> str:
    path = shutil.which(name)
    if not path:
        raise AudioError(f"找不到 {name}; 请先安装 FFmpeg 并确保在 PATH 中")
    return path


def ffmpeg_available() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def decode_to_pcm(path: str, sample_rate: int = SAMPLE_RATE) -> array.array:
    """把任意音频解码成单声道 s16le PCM.

    优先用 ffmpeg (支持 mp3/m4a/…); 没有 ffmpeg 时, 若文件本身是 16-bit PCM
    WAV, 用标准库直接读 —— 这样没有 FFmpeg 也能完成打轴, 只是导出视频不可用。
    """
    if shutil.which("ffmpeg"):
        return _decode_with_ffmpeg(path, sample_rate)
    if path.lower().endswith(".wav"):
        return _decode_wav_stdlib(path, sample_rate)
    raise AudioError("没有找到 FFmpeg; 目前只能直接读取 WAV (16-bit PCM), "
                     "其它格式请先安装 FFmpeg")


def _decode_with_ffmpeg(path: str, sample_rate: int) -> array.array:
    ffmpeg = find_ffmpeg()
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", path,
           "-vn", "-f", "s16le", "-acodec", "pcm_s16le",
           "-ac", "1", "-ar", str(sample_rate), "-"]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        detail = proc.stderr.decode("utf-8", "replace").strip()
        raise AudioError(f"无法解码音频 {os.path.basename(path)}: {detail or 'ffmpeg 失败'}")
    if not proc.stdout:
        raise AudioError(f"音频 {os.path.basename(path)} 解码后为空")
    data = array.array("h")
    usable = len(proc.stdout) - (len(proc.stdout) % BYTES_PER_SAMPLE)
    data.frombytes(proc.stdout[:usable])
    if sys.byteorder != "little":
        data.byteswap()
    return data


def _decode_wav_stdlib(path: str, sample_rate: int) -> array.array:
    import wave

    try:
        with wave.open(path, "rb") as wf:
            channels = wf.getnchannels()
            width = wf.getsampwidth()
            rate = wf.getframerate()
            frames = wf.readframes(wf.getnframes())
    except (wave.Error, EOFError, OSError) as exc:
        raise AudioError(f"无法读取 WAV: {exc}") from exc
    if width != 2:
        raise AudioError("没有 FFmpeg 时只支持 16-bit PCM WAV; 请先安装 FFmpeg")
    data = array.array("h")
    data.frombytes(frames[: len(frames) - len(frames) % 2])
    if sys.byteorder != "little":
        data.byteswap()
    if channels > 1:
        data = array.array("h", data[0::channels])
    if rate != sample_rate:
        data = _resample_linear(data, rate, sample_rate)
    return data


def _resample_linear(data: array.array, src_rate: int, dst_rate: int) -> array.array:
    if not data or src_rate == dst_rate:
        return data
    ratio = dst_rate / src_rate
    out_len = max(1, int(len(data) * ratio))
    out = array.array("h", [0]) * out_len
    last = len(data) - 1
    for i in range(out_len):
        pos = i / ratio
        j = int(pos)
        frac = pos - j
        a = data[j]
        b = data[min(last, j + 1)]
        out[i] = int(a + (b - a) * frac)
    return out


def pcm_to_wav_bytes(pcm: array.array, sample_rate: int = SAMPLE_RATE) -> bytes:
    import io
    import wave

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(BYTES_PER_SAMPLE)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


def write_wav(path: str, pcm: array.array, sample_rate: int = SAMPLE_RATE) -> None:
    with open(path, "wb") as fh:
        fh.write(pcm_to_wav_bytes(pcm, sample_rate))


def probe_duration_ms(path: str) -> int:
    ffprobe = find_ffmpeg("ffprobe")
    cmd = [ffprobe, "-v", "error", "-show_entries", "format=duration",
           "-of", "default=noprint_wrappers=1:nokey=1", path]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return int(round(float(proc.stdout.strip()) * 1000))
    except ValueError:
        return 0


@dataclass
class Peaks:
    """按固定时间桶保存的波形峰谷值, 供时间轴绘制。"""

    bucket_ms: int
    samples: list[tuple[float, float]]
    duration_ms: int

    @classmethod
    def from_pcm(cls, pcm: array.array, sample_rate: int = SAMPLE_RATE,
                 bucket_ms: int = 10) -> "Peaks":
        step = max(1, sample_rate * bucket_ms // 1000)
        peaks: list[tuple[float, float]] = []
        scale = 32768.0
        for i in range(0, len(pcm), step):
            chunk = pcm[i:i + step]
            if not chunk:
                break
            lo = min(chunk) / scale
            hi = max(chunk) / scale
            peaks.append((lo, hi))
        return cls(bucket_ms, peaks, int(round(len(pcm) / sample_rate * 1000)))

    def range_for(self, start_ms: int, end_ms: int) -> tuple[float, float]:
        if not self.samples:
            return 0.0, 0.0
        a = max(0, start_ms // self.bucket_ms)
        b = max(a + 1, min(len(self.samples), (end_ms + self.bucket_ms - 1) // self.bucket_ms))
        lo = min(p[0] for p in self.samples[a:b])
        hi = max(p[1] for p in self.samples[a:b])
        return lo, hi


class AudioPlayer(QObject):
    """基于 QAudioSink 的精确位置播放器。

    ``position_ms`` 是唯一的时间基准: 暂停时冻结, 播放时等于
    ``基准位置 + 已播放毫秒``, 与界面上的游标完全一致。
    """

    positionChanged = Signal(int)
    playingChanged = Signal(bool)
    finished = Signal()

    PAD_MS = 40  # 区间循环时两端留白, 避免切字

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._pcm = array.array("h")
        self._duration_ms = 0
        self._peaks: Peaks | None = None
        self._path = ""
        self._sink: QAudioSink | None = None
        self._buffer: QBuffer | None = None
        self._audio_format = QAudioFormat()
        self._audio_format.setSampleRate(SAMPLE_RATE)
        self._audio_format.setChannelCount(1)
        self._audio_format.setSampleFormat(QAudioFormat.SampleFormat.Int16)
        self._base_ms = 0
        self._playing = False
        self._range: tuple[int, int] | None = None
        self._loop = False
        self._volume = 0.9
        self._timer = QTimer(self)
        self._timer.setInterval(15)
        self._timer.timeout.connect(self._tick)
        self._last_emitted = -1

    # ---------------------------------------------------------------- 载入
    @property
    def path(self) -> str:
        return self._path

    @property
    def duration_ms(self) -> int:
        return self._duration_ms

    @property
    def peaks(self) -> Peaks | None:
        return self._peaks

    @property
    def pcm(self) -> array.array:
        return self._pcm

    def load(self, path: str) -> None:
        self.stop()
        pcm = decode_to_pcm(path)
        self._pcm = pcm
        self._path = path
        self._duration_ms = int(round(len(pcm) / SAMPLE_RATE * 1000))
        self._peaks = Peaks.from_pcm(pcm)
        self._base_ms = 0
        self._range = None
        self._loop = False
        data = QByteArray(pcm.tobytes())
        self._buffer = QBuffer(self)
        self._buffer.setData(data)
        self._buffer.open(QIODevice.OpenModeFlag.ReadOnly)
        self._teardown_sink()
        self._sink = QAudioSink(QMediaDevices.defaultAudioOutput(), self._audio_format, self)
        self._sink.setVolume(self._volume)
        self._sink.setBufferSize(4096)  # ≈43 ms @48k/mono/s16, 降低「听到」与「游标」的偏差
        # 先预热一次: 部分后端在第一次 start() 时才开始建立设备,
        # 导致 processedUSecs 从头计时、比真实播放位置慢。预热后时间基准才准。
        self._sink.start(self._buffer)
        self._sink.suspend()
        self._sink.stop()
        self._buffer.seek(0)
        self.positionChanged.emit(0)

    @property
    def has_audio(self) -> bool:
        return bool(self._pcm)

    # ---------------------------------------------------------------- 状态
    @property
    def is_playing(self) -> bool:
        return self._playing

    @property
    def position_ms(self) -> int:
        if not self._sink or not self._playing:
            return max(0, min(self._duration_ms, self._base_ms))
        delivered = self._sink.processedUSecs() // 1000
        return max(0, min(self._duration_ms, self._base_ms + delivered))

    def set_volume(self, value: float) -> None:
        self._volume = max(0.0, min(1.0, value))
        if self._sink:
            self._sink.setVolume(self._volume)

    # ---------------------------------------------------------------- 播放
    def play(self, from_ms: int | None = None, *, start: int | None = None,
             end: int | None = None, loop: bool = False) -> None:
        if not self.has_audio:
            return
        if start is not None and end is not None:
            self._range = (max(0, start), min(self._duration_ms, end))
            self._loop = loop
        else:
            self._range = None
            self._loop = False
        pos = self.position_ms if from_ms is None else from_ms
        if self._range:
            pos = max(self._range[0], min(self._range[1], pos))
        self._start_at(pos)

    def play_region(self, start_ms: int, end_ms: int, loop: bool = True,
                    pad_ms: int | None = None) -> None:
        pad = self.PAD_MS if pad_ms is None else pad_ms
        start = max(0, start_ms - pad)
        end = min(self._duration_ms, max(start + 30, end_ms + pad))
        self.play(start, start=start, end=end, loop=loop)

    def pause(self) -> None:
        if not self._playing:
            return
        pos = self.position_ms
        self._stop_sink()
        self._base_ms = pos
        self._playing = False
        self._timer.stop()
        self.playingChanged.emit(False)
        self.positionChanged.emit(pos)

    def stop(self) -> None:
        self._stop_sink()
        self._base_ms = 0
        self._range = None
        self._loop = False
        was = self._playing
        self._playing = False
        self._timer.stop()
        if was:
            self.playingChanged.emit(False)
        self._emit_position(force=True)

    def seek(self, ms: int, *, keep_playing: bool | None = None) -> None:
        ms = max(0, min(self._duration_ms, int(ms)))
        should_play = self._playing if keep_playing is None else keep_playing
        in_range = self._range is not None and self._range[0] <= ms <= self._range[1]
        if self._playing:
            self._stop_sink()
        self._base_ms = ms
        self._playing = False
        self._timer.stop()
        if should_play and self.has_audio:
            if self._range and not in_range:
                self._range = None
                self._loop = False
            self._start_at(ms)
        else:
            self._emit_position(force=True)

    def toggle(self) -> None:
        if self._playing:
            self.pause()
        else:
            self.play()

    # ------------------------------------------------------------ 内部实现
    def _start_at(self, pos_ms: int) -> None:
        if not self._sink or not self._buffer:
            return
        self._stop_sink()
        frame = int(pos_ms * SAMPLE_RATE / 1000)
        self._buffer.seek(frame * BYTES_PER_SAMPLE)
        self._base_ms = pos_ms
        self._sink.start(self._buffer)
        self._playing = True
        self._last_emitted = -1
        self._timer.start()
        self.playingChanged.emit(True)
        self._emit_position(force=True)

    def _stop_sink(self) -> None:
        if self._sink:
            try:
                self._sink.stop()
            except RuntimeError:
                pass

    def _teardown_sink(self) -> None:
        if self._sink:
            self._sink.stop()
            self._sink.deleteLater()
            self._sink = None

    def _tick(self) -> None:
        if not self._playing:
            return
        pos = self.position_ms
        if self._range and pos >= self._range[1]:
            if self._loop and self._range[1] > self._range[0]:
                self._start_at(self._range[0])
                return
            self._stop_sink()
            self._base_ms = self._range[1]
            self._playing = False
            self._timer.stop()
            self.playingChanged.emit(False)
            self.positionChanged.emit(self._base_ms)
            self.finished.emit()
            return
        if pos >= self._duration_ms:
            self._stop_sink()
            self._base_ms = self._duration_ms
            self._playing = False
            self._timer.stop()
            self.playingChanged.emit(False)
            self.positionChanged.emit(self._base_ms)
            self.finished.emit()
            return
        self._emit_position()

    def _emit_position(self, force: bool = False) -> None:
        pos = self.position_ms
        if force or pos != self._last_emitted:
            self._last_emitted = pos
            self.positionChanged.emit(pos)
