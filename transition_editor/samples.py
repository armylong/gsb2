"""自生成验证样例: 两段 6 秒 mp4.

A 段: 红底, 白色方块从左向右移动, 帧号递增, 880Hz 持续低音 + 每秒定时短音.
B 段: 蓝底, 白色方块从右向左移动, 帧号递增, 440Hz 持续低音 + 每秒定时短音.
帧号用七段数码管绘制, 不依赖系统字体; 持续低音用于自动化核对重叠区音轨起止.
"""
from __future__ import annotations

import argparse
import os
import subprocess

from .media import FPS, HEIGHT, MAX_SOURCE_SECONDS, WIDTH, MediaError, require_ffmpeg

SAMPLE_SECONDS = 6.0
TONE_A = 880.0   # A 段持续音频率
TONE_B = 440.0   # B 段持续音频率

# 七段数码管段定义: a 上, b 右上, c 右下, d 下, e 左下, f 左上, g 中
_SEGMENTS = {
    "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc",
    "5": "afgcd", "6": "afgedc", "7": "abc", "8": "abcdefg", "9": "abcdfg",
}


def _draw_digit(draw, digit: str, x: int, y: int, s: int, color) -> None:
    """以 (x,y) 为左上画一个宽 4s 高 7s 的七段数码管数字, 笔画粗 s."""
    segs = _SEGMENTS[digit]
    w, h, t = 4 * s, 7 * s, s
    shapes = {
        "a": (x, y, x + w, y + t),
        "g": (x, y + (h - t) // 2, x + w, y + (h + t) // 2),
        "d": (x, y + h - t, x + w, y + h),
        "f": (x, y, x + t, y + h // 2),
        "b": (x + w - t, y, x + w, y + h // 2),
        "e": (x, y + h // 2, x + t, y + h),
        "c": (x + w - t, y + h // 2, x + w, y + h),
    }
    for name in segs:
        draw.rectangle(shapes[name], fill=color)


def draw_number(draw, value: int, x: int, y: int, s: int = 12, color=(255, 255, 255)) -> None:
    for ch in str(value):
        _draw_digit(draw, ch, x, y, s, color)
        x += 6 * s


def _frames(kind: str, nframes: int):
    from PIL import Image, ImageDraw

    bg = (200, 40, 40) if kind == "A" else (40, 40, 200)
    box = 120
    travel = WIDTH - 200 - box
    for n in range(nframes):
        img = Image.new("RGB", (WIDTH, HEIGHT), bg)
        d = ImageDraw.Draw(img)
        # 移动方块: A 从左到右, B 从右到左
        x = 100 + travel * n // nframes
        if kind == "B":
            x = WIDTH - 100 - box - travel * n // nframes
        d.rectangle([x, 300, x + box, 420], fill=(255, 255, 255))
        draw_number(d, n, 40, 40)
        yield img.tobytes()


def _audio_filter(freq: float, seconds: float) -> str:
    """持续低音(音量 0.12) + 每秒最后 0.15s 的定时短音(音量升到 0.6)."""
    return (
        f"sine=frequency={freq}:sample_rate=48000:duration={seconds},"
        "volume=volume='0.12+0.48*gt(mod(t\\,1)\\,0.85)':eval=frame"
    )


def generate_sample(kind: str, out_path: str, seconds: float = SAMPLE_SECONDS) -> None:
    """生成一段样例 mp4(带音频), 不覆盖已有文件除非调用方先删除."""
    if seconds > MAX_SOURCE_SECONDS:
        raise MediaError(f"样例时长超过 {MAX_SOURCE_SECONDS}s 上限")
    require_ffmpeg()
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    freq = TONE_A if kind == "A" else TONE_B
    nframes = round(seconds * FPS)
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS), "-i", "-",
        "-f", "lavfi", "-i", _audio_filter(freq, seconds),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
        "-t", f"{seconds:.6f}",
        out_path,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdin is not None
    for frame in _frames(kind, nframes):
        proc.stdin.write(frame)
    _, err = proc.communicate()
    if proc.returncode != 0:
        raise MediaError(f"生成样例失败:\n{err.decode('utf-8', 'replace')[-1500:]}")


def generate_all(out_dir: str, seconds: float = SAMPLE_SECONDS) -> tuple[str, str]:
    a = os.path.join(out_dir, "sample_a.mp4")
    b = os.path.join(out_dir, "sample_b.mp4")
    generate_sample("A", a, seconds)
    generate_sample("B", b, seconds)
    return a, b


def main() -> None:
    parser = argparse.ArgumentParser(description="生成两段验证样例 mp4")
    parser.add_argument("--out-dir", default="samples", help="输出目录(默认 samples/)")
    parser.add_argument("--seconds", type=float, default=SAMPLE_SECONDS)
    args = parser.parse_args()
    a, b = generate_all(args.out_dir, args.seconds)
    print(f"已生成:\n  {a}\n  {b}")


if __name__ == "__main__":
    main()
