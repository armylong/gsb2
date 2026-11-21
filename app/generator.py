"""测试片生成: 逐帧渲染大号帧号 + 时间码, 管道喂给 ffmpeg, 并写入内嵌时间码.

本机 ffmpeg 未编译 drawtext, 因此画面用内置 5x7 点阵字体在 Python 里渲染,
这样帧号和时间码完全由我们自己的换算逻辑产生, 与被测工具形成闭环:
生成的第 n 帧上写着什么, 核对器里第 n 帧就应当读到什么.
"""
from __future__ import annotations

import subprocess

from .timecode import RateMode, Timecode, format_tc, frame_to_tc, relative_time, tc_to_frame

# 5x7 点阵字体
_FONT = {
    "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
    ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
    ";": ["00000", "00100", "00100", "00000", "00100", "00100", "01000"],
    "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
    ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
    " ": ["00000"] * 7,
    "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
    "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    "N": ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
}


def _draw_text(buf: bytearray, width: int, x: int, y: int, text: str,
               scale: int, color: tuple[int, int, int]):
    r, g, b = color
    cx = x
    for ch in text.upper():
        glyph = _FONT.get(ch, _FONT[" "])
        for gy, row in enumerate(glyph):
            for gx, bit in enumerate(row):
                if bit != "1":
                    continue
                for dy in range(scale):
                    py = y + gy * scale + dy
                    if not 0 <= py < len(buf) // (width * 3):
                        continue
                    base = (py * width + cx + gx * scale) * 3
                    for dx in range(scale):
                        i = base + dx * 3
                        if 0 <= i + 2 < len(buf):
                            buf[i] = r
                            buf[i + 1] = g
                            buf[i + 2] = b
        cx += 6 * scale


def render_frame(width: int, height: int, n: int, tc_text: str, rel_text: str) -> bytes:
    """渲染一帧: 底色随帧号变化, 三行大字分别是帧号 / 素材时间码 / 相对播放时间."""
    bg = (30 + (n * 7) % 60, 30 + (n * 3) % 40, 40 + (n * 11) % 50)
    buf = bytearray(bytes(bg) * (width * height))
    s = max(1, height // 70)
    _draw_text(buf, width, s * 2, s * 4, f"F {n}", s * 4, (255, 220, 0))
    _draw_text(buf, width, s * 2, s * 4 + 8 * s * 4, f"TC {tc_text}", s * 2, (255, 255, 255))
    _draw_text(buf, width, s * 2, s * 4 + 8 * s * 4 + 8 * s * 2, f"REL {rel_text}", s * 2, (140, 220, 255))
    return bytes(buf)


def generate_test_clip(out_path: str, start_tc: Timecode, mode: RateMode,
                       seconds: float, size: tuple[int, int] = (1280, 720),
                       progress=None) -> int:
    """生成测试片, 返回总帧数. 起始时间码带日期偏移时, 内嵌时间码只能写
    24 小时制部分 (容器限制), 画面上的烧录时间码仍带 +N天."""
    width, height = size
    fps_str = "25" if mode is RateMode.NDF_25 else "30000/1001"
    start_frame = tc_to_frame(start_tc, mode)
    total = int(round(seconds * mode.nominal_fps if mode is RateMode.NDF_25
                      else seconds * 30000 / 1001))
    embedded_tc = format_tc(Timecode(start_tc.hh, start_tc.mm, start_tc.ss, start_tc.ff), mode)

    cmd = [
        "ffmpeg", "-v", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}",
        "-r", fps_str, "-i", "-",
        "-timecode", embedded_tc,
        "-frames:v", str(total),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-pix_fmt", "yuv420p",
        out_path,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    try:
        for n in range(total):
            tc_text = format_tc(frame_to_tc(start_frame + n, mode), mode)
            frame = render_frame(width, height, n, tc_text, relative_time(n, mode))
            proc.stdin.write(frame)
            if progress and n % 25 == 0:
                progress(n, total)
        proc.stdin.close()
        rc = proc.wait()
    except BrokenPipeError:
        rc = proc.wait()
    if rc != 0:
        raise RuntimeError(f"ffmpeg 生成失败, 退出码 {rc}")
    return total
