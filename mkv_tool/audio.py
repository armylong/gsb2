from __future__ import annotations

import array
import math
import wave
from pathlib import Path

from .errors import MkvToolError, ffmpeg_path
from .runner import run_capture


def extract_audio_wav(
    source: str | Path,
    stream_index: int,
    destination: str | Path,
    *,
    ffmpeg: str | Path | None = None,
) -> Path:
    """Transcode one selected audio stream to a playback-friendly WAV."""
    exe = ffmpeg_path(ffmpeg)
    dest = Path(destination)
    dest.parent.mkdir(parents=True, exist_ok=True)
    result = run_capture(
        [
            exe,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source),
            "-map",
            f"0:{stream_index}",
            "-vn",
            "-ac",
            "2",
            "-ar",
            "48000",
            "-c:a",
            "pcm_s16le",
            str(dest),
        ]
    )
    if result.returncode != 0:
        raise MkvToolError(f"试听提取失败：\n{result.stderr_tail()}")
    if not dest.exists() or dest.stat().st_size <= 44:
        raise MkvToolError("试听提取没有产生有效的 WAV 文件。")
    return dest


def extract_mono_pcm_wav(
    source: str | Path,
    stream_index: int,
    destination: str | Path,
    *,
    sample_rate: int = 8000,
    ffmpeg: str | Path | None = None,
) -> Path:
    exe = ffmpeg_path(ffmpeg)
    dest = Path(destination)
    result = run_capture(
        [
            exe,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source),
            "-map",
            f"0:{stream_index}",
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(sample_rate),
            "-c:a",
            "pcm_s16le",
            str(dest),
        ]
    )
    if result.returncode != 0:
        raise MkvToolError(f"音频分析提取失败：\n{result.stderr_tail()}")
    return dest


def dominant_frequency(wav_path: str | Path) -> float:
    """Estimate the dominant frequency of a simple tone using zero crossings.

    The generated sample tracks are pure sines, so this is sufficient to prove
    that the retained track is the 880 Hz stream rather than the 440 Hz stream
    or a non-audio stream.
    """
    path = Path(wav_path)
    with wave.open(str(path), "rb") as wf:
        channels = wf.getnchannels()
        sample_width = wf.getsampwidth()
        rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())

    if sample_width != 2:
        raise MkvToolError("频率分析需要 16-bit PCM WAV。")
    samples = array.array("h")
    samples.frombytes(frames)
    if channels > 1:
        # Average interleaved channels with integer rounding.
        mono = array.array("h")
        for i in range(0, len(samples), channels):
            chunk = samples[i : i + channels]
            mono.append(int(sum(chunk) / len(chunk)))
        samples = mono

    # Ignore leading encoder priming and use a stable middle window.
    n = len(samples)
    start = int(n * 0.25)
    end = int(n * 0.75)
    if end - start < rate // 10:
        start, end = 0, n
    segment = samples[start:end]

    crossings = 0
    last = segment[0] if segment else 0
    for value in segment[1:]:
        if last <= 0 < value or last >= 0 > value:
            crossings += 1
        last = value
    duration = (end - start) / rate
    if duration <= 0 or crossings < 4:
        return 0.0
    # Two zero crossings correspond to one period.
    return crossings / (2.0 * duration)


def frequency_strength(wav_path: str | Path, target_hz: float) -> float:
    """Return normalized Goertzel magnitude at target_hz for test assertions."""
    path = Path(wav_path)
    with wave.open(str(path), "rb") as wf:
        channels = wf.getnchannels()
        rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
    samples = array.array("h")
    samples.frombytes(frames)
    if channels > 1:
        samples = samples[::channels]
    n = min(len(samples), rate * 2)
    if n == 0:
        return 0.0
    segment = samples[:n]
    k = int(0.5 + n * target_hz / rate)
    omega = 2.0 * math.pi * k / n
    coeff = 2.0 * math.cos(omega)
    s_prev = 0.0
    s_prev2 = 0.0
    energy = 0.0
    for raw in segment:
        sample = raw / 32768.0
        s = sample + coeff * s_prev - s_prev2
        s_prev2 = s_prev
        s_prev = s
        energy += sample * sample
    power = s_prev2 * s_prev2 + s_prev * s_prev - coeff * s_prev * s_prev2
    if energy <= 0:
        return 0.0
    return power / max(energy, 1e-12)
