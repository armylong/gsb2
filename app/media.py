"""媒体读写: 用 PyAV 解码为内存中的帧/采样, 以及导出 mp4."""

from __future__ import annotations

from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path

import av
import numpy as np

MAX_DURATION_S = 10.0
MAX_WIDTH = 1280
MAX_HEIGHT = 720


@dataclass
class Media:
    """解码后的完整媒体(短片, 全部驻留内存)."""

    path: Path
    frames: list[np.ndarray]  # 每帧 RGB24, (H, W, 3) uint8
    fps: Fraction
    frame_times: list[float]  # 每帧实际显示时刻(秒)
    audio: np.ndarray | None  # (channels, samples) float32, 无音轨时为 None
    sample_rate: int | None
    duration: float  # 视频总时长(秒)

    @property
    def n_frames(self) -> int:
        return len(self.frames)

    @property
    def has_audio(self) -> bool:
        return self.audio is not None

    @property
    def n_channels(self) -> int:
        return int(self.audio.shape[0]) if self.audio is not None else 0


def load_media(path: str | Path) -> Media:
    """导入并校验 mp4: <=10s、<=720p、恒定帧率、至多一条音轨."""
    path = Path(path)
    if path.suffix.lower() != ".mp4":
        raise ValueError(f"只支持 mp4 文件: {path.name}")

    container = av.open(str(path))
    try:
        videos = [s for s in container.streams if s.type == "video"]
        audios = [s for s in container.streams if s.type == "audio"]
        if not videos:
            raise ValueError("文件中没有视频流")
        if len(audios) > 1:
            raise ValueError(f"只支持一条音轨, 当前有 {len(audios)} 条")

        vs = videos[0]
        width, height = vs.width, vs.height
        if width > MAX_WIDTH or height > MAX_HEIGHT:
            raise ValueError(f"分辨率 {width}x{height} 超过 720p 上限")

        fps = Fraction(vs.average_rate)
        if fps <= 0:
            raise ValueError("无法确定帧率")

        # --- 解码视频帧 ---
        frames: list[np.ndarray] = []
        frame_times: list[float] = []
        for frame in container.decode(vs):
            t = float(frame.pts * vs.time_base) if frame.pts is not None else None
            if t is None:
                raise ValueError("视频帧缺少时间戳")
            frame_times.append(t)
            frames.append(frame.to_ndarray(format="rgb24"))

        if len(frames) < 2:
            raise ValueError("视频不足两帧, 无法倒放")

        # 恒定帧率校验: 相邻帧显示间隔必须一致(允许 1ms 抖动)
        deltas = np.diff(frame_times)
        expected = float(1 / fps)
        if np.any(np.abs(deltas - expected) > 1e-3):
            raise ValueError("不是恒定帧率(CFR)视频, 不支持导入")

        duration = frame_times[-1] + expected
        if duration > MAX_DURATION_S + 1e-6:
            raise ValueError(f"时长 {duration:.3f}s 超过 {MAX_DURATION_S:.0f}s 上限")

        # --- 解码音频(可选) ---
        audio: np.ndarray | None = None
        sample_rate: int | None = None
        if audios:
            astream = audios[0]
            sample_rate = astream.rate
            container.seek(0)  # 视频解码已到末尾, 回到开头再解码音频
            resampler = av.AudioResampler(format="fltp", layout=astream.layout, rate=sample_rate)
            chunks: list[np.ndarray] = []
            for frame in container.decode(astream):
                for out in resampler.resample(frame):
                    chunks.append(out.to_ndarray().astype(np.float32))
            for out in resampler.resample(None):
                chunks.append(out.to_ndarray().astype(np.float32))
            if chunks:
                audio = np.concatenate(chunks, axis=1)
                if audio.ndim == 1:
                    audio = audio[np.newaxis, :]
            else:
                sample_rate = None

        return Media(
            path=path,
            frames=frames,
            fps=fps,
            frame_times=frame_times,
            audio=audio,
            sample_rate=sample_rate,
            duration=duration,
        )
    finally:
        container.close()


def export_media(
    out_path: str | Path,
    frames: list[np.ndarray],
    fps: Fraction,
    audio: np.ndarray | None,
    sample_rate: int | None,
) -> None:
    """导出 mp4: h264/yuv420p 视频 + AAC 音频(若有).

    帧数与传入帧列表一致, 帧 pts 严格递增(0, 1, 2, ...), 总时长不变.
    """
    out_path = Path(out_path)
    height, width = frames[0].shape[:2]
    container = av.open(str(out_path), mode="w")
    try:
        vstream = container.add_stream("libx264", rate=fps)
        vstream.width = width
        vstream.height = height
        vstream.pix_fmt = "yuv420p"
        frame_tb = Fraction(1, 1) / fps

        astream = None
        if audio is not None and sample_rate is not None:
            n_ch = int(audio.shape[0])
            layout = {1: "mono", 2: "stereo"}.get(n_ch)
            if layout is None:
                raise ValueError(f"不支持的声道数: {n_ch}")
            astream = container.add_stream("aac", rate=sample_rate)
            astream.layout = layout
            astream.time_base = Fraction(1, sample_rate)

        for i, arr in enumerate(frames):
            vf = av.VideoFrame.from_ndarray(np.ascontiguousarray(arr), format="rgb24")
            vf.pts = i
            vf.time_base = frame_tb
            for pkt in vstream.encode(vf):
                container.mux(pkt)
        for pkt in vstream.encode(None):
            container.mux(pkt)

        if astream is not None:
            n = int(audio.shape[1])
            block = 1024
            pos = 0
            while pos < n:
                chunk = np.ascontiguousarray(audio[:, pos : pos + block], dtype=np.float32)
                af = av.AudioFrame.from_ndarray(chunk, format="fltp", layout=astream.layout)
                af.sample_rate = sample_rate
                af.pts = pos
                af.time_base = Fraction(1, sample_rate)
                for pkt in astream.encode(af):
                    container.mux(pkt)
                pos += block
            for pkt in astream.encode(None):
                container.mux(pkt)
    finally:
        container.close()
