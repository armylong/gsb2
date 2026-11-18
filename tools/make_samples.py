"""生成同步核对样例: 同一运动事件 + 画内时码的两份不同帧率 mp4。

不依赖任何图像库: numpy 生成 RGB 帧, 经 rawvideo 管道直送 ffmpeg 编码,
文字用内置 5x7 点阵字体烧录。

场景:
- 一个方块沿固定轨迹做周期运动, 画面烧录"事件时间"和帧序号;
  事件时间是该帧在统一场景时钟下的时间, 可肉眼逐帧核对。
- A: 30fps, 从场景时间 0 开始; B: 24fps, 从场景时间 START_OFFSET_B 开始
  (默认 +0.500s)。要让两边显示同一事件, 由约定
      B内容时间 = 主时间 + offset
  得标准答案 offset = -START_OFFSET_B = -0.500s。
- 两路各带一段不同频率的正弦音频, 便于分辨当前监听的是哪一路。

用法:
  python -m tools.make_samples --out samples
"""
from __future__ import annotations

import argparse
import math
import os
import subprocess
import sys

import numpy as np

FFMPEG = os.environ.get("FFMPEG_BIN", "ffmpeg")

WIDTH, HEIGHT = 960, 540  # 不超过 720p
FPS_A, FPS_B = 30, 24
DURATION_A, DURATION_B = 10.0, 9.5
START_OFFSET_B = 0.500  # B 起点相对场景时钟的已知差异(正: B 内容更晚)

# ---------- 5x7 点阵字体(覆盖 0-9、A-Z、空格与少量符号) ----------
FONT = {
    "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    "=": ["00000", "00000", "11111", "00000", "11111", "00000", "00000"],
    ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
    ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
    "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
    "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
    "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
    " ": ["00000"] * 7,
}


def _draw_text(buf: np.ndarray, text: str, x0: int, y0: int,
               scale: int, color=(255, 255, 255)) -> None:
    x = x0
    for ch in text.upper():
        glyph = FONT.get(ch, FONT[" "])
        for row, bits in enumerate(glyph):
            for col, bit in enumerate(bits):
                if bit == "1":
                    buf[
                        y0 + row * scale: y0 + (row + 1) * scale,
                        x + col * scale: x + (col + 1) * scale,
                    ] = color
        x += 6 * scale


def _frame(label: str, scene_time: float, frame_no: int, fps: float,
           bg: tuple[int, int, int]) -> np.ndarray:
    buf = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    buf[:, :] = bg
    # 方块轨迹只由场景时间决定 => 同事件同位姿
    bx = 120 + (WIDTH - 320) * (0.5 + 0.5 * math.sin(2 * math.pi * scene_time / 4.0))
    by = 120 + (HEIGHT - 300) * (0.5 + 0.5 * math.sin(2 * math.pi * scene_time / 6.0))
    x0, y0 = int(bx) - 40, int(by) - 40
    buf[max(0, y0): y0 + 80, max(0, x0): x0 + 80] = (255, 209, 102)

    _draw_text(buf, label, 24, 24, 4)
    _draw_text(
        buf,
        f"EVENT={scene_time:07.3f}S FRAME={frame_no:03d} {fps:.0f}FPS",
        24, 72, 3,
    )
    _draw_text(
        buf, "SAME MOTION EVENT - DIFFERENT CAPTURE RATE",
        24, HEIGHT - 40, 2, color=(215, 227, 255),
    )
    return buf


def _render(label: str, fps: float, duration: float, start_scene: float,
            bg: tuple[int, int, int]) -> np.ndarray:
    count = round(duration * fps)
    frames = np.empty((count, HEIGHT, WIDTH, 3), dtype=np.uint8)
    for i in range(count):
        frames[i] = _frame(label, start_scene + i / fps, i, fps, bg)
    return frames


def _encode(frames: np.ndarray, fps: float, audio_freq: int,
            out_path: str) -> None:
    count = frames.shape[0]
    duration = count / fps
    cmd = [
        FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{WIDTH}x{HEIGHT}", "-framerate", str(fps),
        "-i", "pipe:0",
        "-f", "lavfi", "-i",
        f"sine=frequency={audio_freq}:sample_rate=48000:duration={duration}",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(fps),
        "-c:a", "aac", "-shortest", "-movflags", "+faststart",
        out_path,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    proc.communicate(frames.tobytes())
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg 编码失败: {out_path}")


def make(out_root: str) -> dict:
    os.makedirs(out_root, exist_ok=True)
    frames_a = _render("A", FPS_A, DURATION_A, 0.0, (22, 50, 79))
    frames_b = _render(
        "B", FPS_B, DURATION_B, START_OFFSET_B, (58, 29, 77)
    )
    path_a = os.path.abspath(os.path.join(out_root, "sample_a.mp4"))
    path_b = os.path.abspath(os.path.join(out_root, "sample_b.mp4"))
    _encode(frames_a, FPS_A, 440, path_a)
    _encode(frames_b, FPS_B, 660, path_b)
    return {
        "path_a": path_a,
        "path_b": path_b,
        "fps_a": FPS_A,
        "fps_b": FPS_B,
        "start_offset_b": START_OFFSET_B,
        "expected_sync_offset": -START_OFFSET_B,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="生成双视频同步核对样例")
    parser.add_argument("--out", default="samples", help="输出目录")
    args = parser.parse_args(argv[1:])
    info = make(args.out)
    print("样例已生成:")
    for k, v in info.items():
        print(f"  {k}: {v}")
    print(
        "\n核对方法: 在播放器里把 B 偏移调到 -0.5000s, 两边方块应同位姿、"
        "画内 EVENT 时间应一致(各自帧号不同是正常的)。"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
