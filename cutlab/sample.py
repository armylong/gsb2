"""生成带规律关键帧、烧录计数与机器可读条码的样例视频。"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import wave
from dataclasses import dataclass, asdict
from pathlib import Path

from . import barcode
from . import ffmpeg


@dataclass(slots=True)
class SampleSpec:
    duration: float = 8.0
    fps: int = 30
    width: int = 640
    height: int = 360
    gop_seconds: float = 1.0
    audio_rate: int = 48000
    offset: float = 0.0
    audio_lead: float = 0.0   # 音轨比画面提前多少秒开始（用于演示非零起点定位）
    name: str = "sample"

    @property
    def frames(self) -> int:
        return int(round(self.duration * self.fps))

    @property
    def gop_frames(self) -> int:
        return max(1, int(round(self.gop_seconds * self.fps)))


def _ensure_qt() -> None:
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    global _APP
    from PySide6.QtGui import QGuiApplication
    if QGuiApplication.instance() is None:
        _APP = QGuiApplication(sys.argv[:1])


_APP = None


def _font(size: int, *, bold: bool = False):
    from PySide6.QtGui import QFont
    font = QFont()
    try:
        font.setFamilies(["Menlo", "SF Mono", "DejaVu Sans Mono", "Liberation Mono"])
    except AttributeError:  # pragma: no cover - 旧 Qt
        font.setFamily("Menlo")
    font.setPixelSize(size)
    font.setBold(bold)
    return font


def render_frame(spec: SampleSpec, index: int) -> "object":
    """绘制第 index 帧（QImage，RGB888）。"""
    from PySide6.QtCore import QRect, Qt
    from PySide6.QtGui import (QBrush, QColor, QImage, QLinearGradient,
                               QPainter)

    _ensure_qt()
    w, h = spec.width, spec.height
    image = QImage(w, h, QImage.Format.Format_RGB888)
    grad = QLinearGradient(0, 0, w, h)
    grad.setColorAt(0.0, QColor(16, 22, 34))
    grad.setColorAt(1.0, QColor(44, 22, 54))
    painter = QPainter(image)
    painter.fillRect(0, 0, w, h, QBrush(grad))

    # 时间位置色带
    progress = index / max(1, spec.frames - 1)
    painter.fillRect(0, h - 6, w, 6, QColor(50, 60, 80))
    painter.fillRect(0, h - 6, int(w * progress), 6, QColor(80, 200, 255))

    # 条码区
    geo = barcode.geometry(w, h)
    painter.fillRect(geo.x0 - 8, geo.y - 8, geo.total_width + 16,
                     geo.cell_h + 16, QColor(255, 255, 255))
    bits = barcode.encode_bits(index)
    for k, bit in enumerate(bits):
        x = geo.x0 + k * geo.cell
        color = QColor(10, 10, 10) if bit else QColor(250, 250, 250)
        painter.fillRect(x, geo.y, geo.cell, geo.cell_h, color)

    # 字幕计数
    painter.setPen(QColor(255, 255, 255))
    painter.setFont(_font(max(24, int(h * 0.19)), bold=True))
    painter.drawText(QRect(int(w * 0.05), int(h * 0.34), int(w * 0.9), int(h * 0.25)),
                     Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                     f"FRAME {index:04d}")

    painter.setFont(_font(max(12, int(h * 0.065))))
    painter.setPen(QColor(235, 240, 255))
    content_t = index / spec.fps
    abs_t = spec.offset + content_t
    text = f"t={content_t:07.3f}s  pts={abs_t:08.3f}s  #{index:03d}"
    painter.drawText(QRect(int(w * 0.05), int(h * 0.62), int(w * 0.9), int(h * 0.1)),
                     Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, text)

    # 关键帧角标
    if index % spec.gop_frames == 0:
        painter.setPen(QColor(20, 20, 20))
        painter.setBrush(QColor(120, 255, 150))
        painter.drawRect(int(w * 0.05), int(h * 0.78), int(w * 0.10), int(h * 0.09))
        painter.setFont(_font(max(10, int(h * 0.045)), bold=True))
        painter.drawText(QRect(int(w * 0.05), int(h * 0.78), int(w * 0.10), int(h * 0.09)),
                         Qt.AlignmentFlag.AlignCenter, "KEY")
    else:
        painter.setPen(QColor(150, 160, 190))
        painter.setFont(_font(max(10, int(h * 0.045))))
        painter.drawText(QRect(int(w * 0.05), int(h * 0.78), int(w * 0.4), int(h * 0.09)),
                         Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                         f"GOP {spec.gop_frames} · {spec.fps} fps")

    painter.setFont(_font(max(9, int(h * 0.035))))
    painter.setPen(QColor(110, 170, 210))
    painter.drawText(QRect(int(w * 0.55), int(h * 0.78), int(w * 0.4), int(h * 0.09)),
                     Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter,
                     "CUTLAB SAMPLE")
    painter.end()
    return image


def _image_rgb(image) -> bytes:
    width, height = image.width(), image.height()
    bpl = image.bytesPerLine()
    raw = bytes(image.constBits())
    if bpl == width * 3:
        return raw[:bpl * height]
    out = bytearray()
    for y in range(height):
        out += raw[y * bpl:y * bpl + width * 3]
    return bytes(out)


def _write_wav(path: Path, spec: SampleSpec) -> None:
    """写入带可定位包络的测试音。

    音频设计目标：任意 0.5 秒片段都能被唯一对齐，同时听感不刺耳。
    每 40 ms 为一个“节拍窗”，窗内振幅由固定伪随机序列决定（-24 dB ~ -3 dB），
    窗内再叠 440 Hz 基频；每 0.5 秒整点额外加入 1 ms 的 2 kHz 标记音。
    """
    rate = spec.audio_rate
    total = int(round(spec.duration * rate))
    window = int(rate * 0.04)
    # 固定序列，保证生成结果可复现
    pattern = [0.06, 0.5, 0.12, 0.85, 0.25, 0.7, 0.09, 0.4,
               0.95, 0.18, 0.55, 0.3, 0.75, 0.08, 0.62, 0.35,
               0.88, 0.15, 0.45, 0.68, 0.1, 0.78, 0.22, 0.58]
    samples = bytearray()
    for n in range(total):
        t = n / rate
        gain = pattern[(n // window) % len(pattern)]
        value = gain * 0.5 * math.sin(2 * math.pi * 440.0 * t)
        phase = t % 0.5
        if phase < 0.002:
            value += 0.6 * math.sin(2 * math.pi * 2000.0 * t)
        if t >= spec.duration - 0.03:
            value *= 0.0
        s = int(max(-1.0, min(1.0, value)) * 32767)
        samples += s.to_bytes(2, "little", signed=True)
    with wave.open(str(path), "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(rate)
        fh.writeframes(bytes(samples))


def generate(directory: str | Path, spec: SampleSpec | None = None,
             progress=None) -> dict:
    """生成样例并返回清单（含实测关键帧位置）。"""
    _ensure_qt()
    spec = spec or SampleSpec()
    out_dir = Path(directory)
    out_dir.mkdir(parents=True, exist_ok=True)
    suffix = _suffix(spec.offset, spec.audio_lead)
    video_path = out_dir / f"{spec.name}{suffix}.mp4"
    wav_path = out_dir / f"{spec.name}{suffix}.wav"

    _write_wav(wav_path, spec)

    args = [
        ffmpeg.ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-nostats", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{spec.width}x{spec.height}", "-r", str(spec.fps), "-i", "-",
    ]
    if spec.audio_lead:
        args += ["-itsoffset", f"{-spec.audio_lead:.6f}"]
    args += [
        "-i", str(wav_path),
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-g", str(spec.gop_frames), "-keyint_min", str(spec.gop_frames),
        "-sc_threshold", "0", "-bf", "2", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-shortest",
    ]
    if spec.offset:
        args += ["-output_ts_offset", f"{spec.offset:.6f}"]
    args.append(str(video_path))

    proc = subprocess.Popen(args, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        assert proc.stdin is not None
        for i in range(spec.frames):
            proc.stdin.write(_image_rgb(render_frame(spec, i)))
            if progress and (i % 15 == 0 or i == spec.frames - 1):
                progress(int((i + 1) / spec.frames * 100))
    except BrokenPipeError:
        pass
    finally:
        if proc.stdin is not None:
            try:
                proc.stdin.close()
            except BrokenPipeError:
                pass
    stderr = (proc.stderr.read() if proc.stderr else b"").decode("utf-8", "replace")
    if proc.stderr is not None:
        proc.stderr.close()
    code = proc.wait()
    wav_path.unlink(missing_ok=True)
    if code != 0:
        raise ffmpeg.FFmpegError(f"生成样例失败（退出码 {code}）\n{stderr[-1500:]}", args, stderr)

    manifest = asdict(spec)
    manifest.update({
        "path": str(video_path),
        "frames": spec.frames,
        "gop_frames": spec.gop_frames,
        "barcode": {
            "sync": barcode.N_SYNC, "data": barcode.N_DATA,
            "check": barcode.N_CHECK, "max_index": barcode.MAX_FRAME,
        },
        "audio_pattern": "每 40ms 随机振幅的 440Hz 测试音，每 0.5s 叠加 2kHz 标记音",
    })
    manifest_path = out_dir / f"{spec.name}{suffix}.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def _suffix(offset: float, audio_lead: float) -> str:
    parts = []
    if offset:
        parts.append(f"offset{int(offset)}")
    if audio_lead:
        parts.append(f"lead{int(round(audio_lead * 1000))}ms")
    return ("_" + "_".join(parts)) if parts else ""


def ensure_sample(directory: str | Path, *, offset: float = 0.0,
                  audio_lead: float = 0.0, progress=None) -> dict:
    directory = Path(directory)
    spec = SampleSpec(offset=offset, audio_lead=audio_lead, name="sample")
    suffix = _suffix(offset, audio_lead)
    target = directory / f"sample{suffix}.mp4"
    manifest = directory / f"sample{suffix}.json"
    if target.is_file() and manifest.is_file():
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
            if data.get("frames") == spec.frames:
                return data
        except (OSError, json.JSONDecodeError):
            pass
    return generate(directory, spec, progress=progress)
