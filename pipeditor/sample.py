"""程序化生成验证样例(无需任何附件)。

生成内容
========
* ``background.mp4``: 1280x720, 30fps, 8 秒, 带每 50/100 像素网格与坐标标注,
  含 440Hz 背景音频(用于核对背景音频全程保留)。
* ``overlay.mp4``: 320x240, 30fps, 5 秒, 橙色填充 + 蓝色边框的彩色小窗口,
  含 880Hz 音频(导出时应被丢弃, 只留背景声)。
* ``sample_keyframes.json``: 三点移动样例(帧 0 / 90 / 180)。

叠加层 5 秒(150 帧)短于背景 8 秒(240 帧), 可同时核对关键帧端点、
两点中点、叠加结束前后(149 帧仍在、150 帧消失)。

用法: ``python -m pipeditor.sample [输出目录]``
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

BG_W, BG_H, BG_FPS, BG_SECONDS = 1280, 720, 30, 8
OV_W, OV_H, OV_FPS, OV_SECONDS = 320, 240, 30, 5
BG_TONE, OV_TONE = 440, 880

# 三点样例: 叠加尺寸 320x240, 合法范围 x<=960, y<=480。
SAMPLE_KEYFRAMES = [
    {"frame": 0, "x": 40, "y": 40},
    {"frame": 90, "x": 900, "y": 440},
    {"frame": 180, "x": 480, "y": 60},
]

_FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in _FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def draw_background(frame: int) -> np.ndarray:
    img = Image.new("RGB", (BG_W, BG_H), (245, 245, 245))
    d = ImageDraw.Draw(img)
    font = _load_font(14)
    big = _load_font(22)

    for x in range(0, BG_W + 1, 50):
        major = x % 100 == 0
        color = (150, 150, 150) if major else (215, 215, 215)
        d.line([(x, 0), (x, BG_H)], fill=color, width=2 if major else 1)
        if major:
            d.text((x + 3, 2), str(x), fill=(80, 80, 80), font=font)
    for y in range(0, BG_H + 1, 50):
        major = y % 100 == 0
        color = (150, 150, 150) if major else (215, 215, 215)
        d.line([(0, y), (BG_W, y)], fill=color, width=2 if major else 1)
        if major:
            d.text((2, y + 3), str(y), fill=(80, 80, 80), font=font)

    # 角上的原点标注, 方便人工核对左上角像素坐标。
    d.text((6, 24), "(0,0)", fill=(0, 0, 0), font=font)
    t = frame / BG_FPS
    d.text(
        (BG_W - 250, 6),
        f"BG frame {frame:03d}  t={t:6.3f}s",
        fill=(0, 0, 0),
        font=big,
    )
    return np.asarray(img, dtype=np.uint8).copy()


def draw_overlay(frame: int) -> np.ndarray:
    img = Image.new("RGB", (OV_W, OV_H), (255, 140, 0))
    d = ImageDraw.Draw(img)
    border = 8
    d.rectangle(
        [0, 0, OV_W - 1, OV_H - 1], outline=(0, 80, 220), width=border
    )
    big = _load_font(28)
    small = _load_font(18)
    d.text((OV_W // 2 - 70, OV_H // 2 - 34), "PIP", fill=(255, 255, 255), font=big)
    d.text(
        (OV_W // 2 - 80, OV_H // 2 + 6),
        f"frame {frame:03d}",
        fill=(255, 255, 255),
        font=small,
    )
    return np.asarray(img, dtype=np.uint8).copy()


def _encode_video(
    out_path: Path,
    width: int,
    height: int,
    fps: int,
    seconds: float,
    tone: int,
    frame_fn,
) -> None:
    frame_count = round(fps * seconds)
    cmd = [
        "ffmpeg",
        "-y",
        "-v",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        f"{width}x{height}",
        "-r",
        str(fps),
        "-i",
        "pipe:0",
        "-f",
        "lavfi",
        "-i",
        f"sine=frequency={tone}:duration={seconds}",
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "18",
        "-preset",
        "ultrafast",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-t",
        f"{seconds:g}",
        str(out_path),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdin is not None
    try:
        for i in range(frame_count):
            proc.stdin.write(frame_fn(i).tobytes())
        proc.stdin.close()
    except BrokenPipeError:
        pass
    err = proc.stderr.read()
    code = proc.wait()
    if code != 0:
        raise RuntimeError(f"生成 {out_path} 失败: {err.decode('utf-8', 'replace')}")


def generate(out_dir: str | Path) -> dict[str, Path]:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    bg_path = out / "background.mp4"
    ov_path = out / "overlay.mp4"
    json_path = out / "sample_keyframes.json"

    _encode_video(
        bg_path, BG_W, BG_H, BG_FPS, BG_SECONDS, BG_TONE, draw_background
    )
    _encode_video(ov_path, OV_W, OV_H, OV_FPS, OV_SECONDS, OV_TONE, draw_overlay)

    payload = {
        "canvas": {"width": BG_W, "height": BG_H, "fps": BG_FPS},
        "overlay_size": {"width": OV_W, "height": OV_H},
        "overlay_frame_count": OV_FPS * OV_SECONDS,
        "keyframes": SAMPLE_KEYFRAMES,
        "check_points": {
            "frame0": [40, 40],
            "frame45_midpoint": [470, 240],
            "frame90": [900, 440],
            "frame149_last_visible_note": "第149帧仍可见, 第150帧起消失",
        },
    }
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    return {"background": bg_path, "overlay": ov_path, "keyframes": json_path}


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    out_dir = Path(argv[0]) if argv else Path("sample_data")
    paths = generate(out_dir)
    print("样例已生成:")
    for name, path in paths.items():
        print(f"  {name:10s} {path}")
    print("\n三点关键帧(叠加层 320x240, 坐标为画布左上角像素):")
    for kf in SAMPLE_KEYFRAMES:
        print(
            f"  帧 {kf['frame']:3d}  t={kf['frame'] / BG_FPS:4.1f}s  "
            f"位置=({kf['x']}, {kf['y']})"
        )
    print("\n核对: 帧45为前两点中点(470,240); 帧149可见, 帧150消失; 背景音频 8 秒。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
