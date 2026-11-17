"""生成自校验样例视频：
  - 画面：每秒一种底色，大字显示 秒时间戳 + 帧号，顶部 16 位二进制条码编码帧号
          （供自动化验证直接从输出帧读回源帧号），一个匀速移动的圆点。
  - 音频：440Hz 连续正弦（验证保调），每个整秒叠加 60ms 的 1000Hz 短促哔声
          （验证变速后事件时刻与映射表一致、音视频同步）。
默认 12 秒、30fps，默认分段建议 慢放0.5x / 原速1.0x / 快放2.0x 三段。
"""
from __future__ import annotations

import math
import subprocess
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# 条码布局（verify.py 读取时共用）
BARCODE_BITS = 16
BARCODE_X0 = 40
BARCODE_Y0 = 4
BARCODE_BLOCK_W = 40
BARCODE_BLOCK_H = 24

SAMPLE_WIDTH = 960
SAMPLE_HEIGHT = 540
SAMPLE_FPS = 30
SAMPLE_DURATION = 12.0
TONE_FREQ = 440.0
BEEP_FREQ = 1000.0
BEEP_LEN = 0.06
AUDIO_SR = 48000


def _font(scale: int = 4) -> ImageFont.ImageFont:
    try:
        return ImageFont.load_default(size=14 * scale)
    except TypeError:  # 旧版 Pillow 不支持 size 参数
        return ImageFont.load_default()


def make_frame(frame_idx: int, fps: int = SAMPLE_FPS,
               w: int = SAMPLE_WIDTH, h: int = SAMPLE_HEIGHT) -> np.ndarray:
    t = frame_idx / fps
    sec = int(t)
    # 每秒换一种底色，肉眼即可区分时刻
    hue = (sec * 47) % 360
    img = Image.new("RGB", (w, h))
    dr = ImageDraw.Draw(img)
    dr.rectangle([0, 0, w, h], fill=_hsv(hue, 0.45, 0.55))
    dr.rectangle([0, h - 90, w, h], fill=(20, 20, 24))

    # 顶部帧号条码：白块=1 黑块=0，高位在左
    for b in range(BARCODE_BITS):
        bit = (frame_idx >> (BARCODE_BITS - 1 - b)) & 1
        x0 = BARCODE_X0 + b * BARCODE_BLOCK_W
        color = (245, 245, 245) if bit else (15, 15, 15)
        dr.rectangle([x0, BARCODE_Y0, x0 + BARCODE_BLOCK_W - 2,
                      BARCODE_Y0 + BARCODE_BLOCK_H], fill=color)
    dr.rectangle([BARCODE_X0 - 2, BARCODE_Y0 - 2,
                  BARCODE_X0 + BARCODE_BITS * BARCODE_BLOCK_W, BARCODE_Y0 + BARCODE_BLOCK_H + 2],
                 outline=(255, 255, 0), width=2)

    font_big = _font(4)
    font_mid = _font(3)
    dr.text((40, 80), f"T = {t:8.3f} s", font=font_big, fill=(255, 255, 255))
    dr.text((40, 170), f"FRAME # {frame_idx:04d}", font=font_big, fill=(255, 255, 120))
    dr.text((40, h - 75), f"SRC {t:7.3f}s  |  frame {frame_idx}  |  {fps}fps  |  tone 440Hz + 1kHz beep/s",
            font=font_mid, fill=(230, 230, 230))

    # 匀速移动圆点，便于肉眼判断变速
    cx = int((t * 90) % (w - 80)) + 40
    dr.ellipse([cx - 18, 300 - 18, cx + 18, 300 + 18], fill=(255, 90, 90))
    return np.asarray(img)


def _hsv(h: float, s: float, v: float) -> tuple[int, int, int]:
    i = int(h // 60) % 6
    f = h / 60 - int(h // 60)
    p, q, tt = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
    rgb = [(v, tt, p), (q, v, p), (p, v, tt), (p, q, v), (tt, p, v), (v, p, q)][i]
    return tuple(int(round(c * 255)) for c in rgb)


def make_audio(path: Path, duration: float = SAMPLE_DURATION, sr: int = AUDIO_SR) -> None:
    n = int(round(duration * sr))
    t = np.arange(n) / sr
    audio = 0.25 * np.sin(2 * math.pi * TONE_FREQ * t)
    # 每个整秒叠加 60ms 的 1kHz 哔声（带 5ms 淡入淡出，避免自身产生爆音）
    for k in range(int(duration)):
        start = int(k * sr)
        length = min(int(BEEP_LEN * sr), n - start)
        if length <= 0:
            continue
        env = np.ones(length)
        fade = min(int(0.005 * sr), length // 2)
        env[:fade] = np.linspace(0, 1, fade)
        env[-fade:] = np.linspace(1, 0, fade)
        tt = np.arange(length) / sr
        audio[start:start + length] += 0.35 * env * np.sin(2 * math.pi * BEEP_FREQ * tt)
    pcm = np.clip(audio, -1, 1)
    pcm = (pcm * 32767).astype("<i2")
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())


def generate_sample(out_path: str | Path, duration: float = SAMPLE_DURATION,
                    fps: int = SAMPLE_FPS) -> Path:
    """生成样例 mp4（H.264 + AAC），返回路径。"""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_video = out_path.with_suffix(".video_only.mp4")
    tmp_audio = out_path.with_suffix(".wav")

    n_frames = int(round(duration * fps))
    cmd = [
        "ffmpeg", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{SAMPLE_WIDTH}x{SAMPLE_HEIGHT}", "-r", str(fps),
        "-i", "-",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium",
        "-movflags", "+faststart",
        str(tmp_video),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    assert proc.stdin is not None
    for i in range(n_frames):
        proc.stdin.write(make_frame(i, fps).tobytes())
    proc.stdin.close()
    err = proc.stderr.read().decode()
    if proc.wait() != 0:
        raise RuntimeError(f"样例视频编码失败:\n{err[-2000:]}")

    make_audio(tmp_audio, duration)
    mux = subprocess.run(
        ["ffmpeg", "-y", "-i", str(tmp_video), "-i", str(tmp_audio),
         "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
         "-movflags", "+faststart", str(out_path)],
        capture_output=True, text=True)
    if mux.returncode != 0:
        raise RuntimeError(f"样例音视频合流失败:\n{mux.stderr[-2000:]}")
    tmp_video.unlink(missing_ok=True)
    tmp_audio.unlink(missing_ok=True)
    return out_path


def default_segments(duration: float = SAMPLE_DURATION) -> list[dict]:
    """默认三段：慢放 0.5x / 原速 1.0x / 快放 2.0x。"""
    third = duration / 3.0
    return [
        {"start": 0.0, "end": third, "speed": 0.5},
        {"start": third, "end": 2 * third, "speed": 1.0},
        {"start": 2 * third, "end": duration, "speed": 2.0},
    ]
