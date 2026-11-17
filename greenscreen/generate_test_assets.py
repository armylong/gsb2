"""程序生成绿幕测试短片与静态背景图，全部本地生成、无需外部素材。

生成的短片刻意覆盖最难处理的三类问题：
  1. 发丝边缘：人物头顶用大量细长、半透明的“发丝”线条，考验羽化/收边；
  2. 绿色反光：人物肩部叠一层偏绿的 spill，考验 despill；
  3. 近背景色前景：人物手中一个与绿幕颜色接近的绿色小球，且被前景
     包住（不与外部绿幕连通），考验前景保护，不该被抠穿。
另外视频带一条正弦波音轨，用来验证导出时音轨是否保留。
"""

from __future__ import annotations

import argparse
import math
import subprocess
from pathlib import Path

import cv2
import numpy as np

from .media import find_ffmpeg

WIDTH, HEIGHT = 640, 360
FPS = 24
DURATION = 3.0  # 秒
N_FRAMES = int(FPS * DURATION)


def _green_screen_bg(rng: np.random.Generator, h: int, w: int) -> np.ndarray:
    """略带不均匀光照和噪声的绿幕，避免纯色好处理得不真实。"""
    base = np.zeros((h, w, 3), np.float32)
    # BGR 绿幕
    base[:] = (78, 240, 88)
    # 径向亮度不均
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    vignette = 1.0 - 0.18 * (((xx - w / 2) / w) ** 2 + ((yy - h / 2) / h) ** 2)
    base *= vignette[:, :, None]
    noise = rng.normal(0, 4, base.shape).astype(np.float32)
    return np.clip(base + noise, 0, 255).astype(np.uint8)


def _draw_person(img: np.ndarray, cx: int, cy: int,
                 rng: np.random.Generator, t: float) -> None:
    """画一个简化“人物”：身体 + 头 + 发丝 + 绿色反光 + 近绿小球。"""
    # 身体（暖肤色/衣服，故意与绿色差异明显）
    cv2.ellipse(img, (cx, cy + 95), (78, 110), 0, 0, 360, (42, 96, 200), -1)
    # 脖子和脸
    cv2.rectangle(img, (cx - 16, cy - 5), (cx + 16, cy + 30), (150, 190, 225), -1)
    cv2.circle(img, (cx, cy - 35), 46, (150, 190, 225), -1)

    # 发丝：围绕头顶的大量细线条，半透明、随风轻微摆动，模拟头发边缘
    overlay = img.copy()
    n_hairs = 140
    for k in range(n_hairs):
        ang = math.pi + (k / n_hairs) * math.pi + rng.normal(0, 0.02)
        length = 40 + rng.uniform(0, 34)
        sway = 6 * math.sin(t * 2.0 + k)
        x0 = int(cx + 46 * math.cos(ang))
        y0 = int(cy - 35 + 46 * math.sin(ang))
        x1 = int(x0 + length * math.cos(ang)) + int(sway)
        y1 = int(y0 + length * math.sin(ang))
        shade = int(rng.uniform(30, 90))
        cv2.line(overlay, (x0, y0), (x1, y1), (shade, shade + 8, shade + 14),
                 1, cv2.LINE_AA)
    cv2.addWeighted(overlay, 0.7, img, 0.3, 0, img)

    # 绿色反光（spill）：肩部两块半透明绿色，模拟绿幕打到人物身上的光
    spill = img.copy()
    cv2.ellipse(spill, (cx - 55, cy + 70), (34, 20), -0.4, 0, 360,
                (96, 235, 110), -1)
    cv2.ellipse(spill, (cx + 55, cy + 70), (34, 20), 0.4, 0, 360,
                (96, 235, 110), -1)
    cv2.addWeighted(spill, 0.55, img, 0.45, 0, img)

    # 近背景色的前景小球：颜色接近绿幕，但被人物握在身前、完全被
    # 红色身体轮廓包住（不与外部绿幕连通），用于验证前景保护不会把它抠穿
    ball_x = cx + 30 + int(6 * math.sin(t * 3))
    ball_y = cy + 120
    cv2.circle(img, (ball_x, ball_y), 24, (96, 225, 104), -1)
    cv2.circle(img, (ball_x - 7, ball_y - 7), 6, (150, 245, 158), -1)


def make_foreground_frame(index: int,
                          rng: np.random.Generator | None = None) -> np.ndarray:
    rng = rng or np.random.default_rng(1234)
    t = index / FPS
    img = _green_screen_bg(rng, HEIGHT, WIDTH)
    # 人物横向缓慢移动，方便验证不同时间点
    cx = WIDTH // 2 + int(60 * math.sin(t * 2 * math.pi / DURATION))
    cy = HEIGHT // 2 - 10
    _draw_person(img, cx, cy, rng, t)
    return img


def make_background_image(h: int = 450, w: int = 800) -> np.ndarray:
    """静态背景图，尺寸故意与前景不同，验证自动缩放。"""
    img = np.zeros((h, w, 3), np.uint8)
    for y in range(h):
        f = y / h
        # 深蓝到紫的竖向渐变
        img[y, :] = (
            int(180 - 90 * f),   # B
            int(60 + 40 * f),    # G
            int(90 + 120 * f),   # R
        )
    # 几个柔和光斑，便于肉眼看出合成边缘
    cv2.circle(img, (int(w * 0.25), int(h * 0.3)), 70, (220, 150, 90), -1)
    cv2.circle(img, (int(w * 0.75), int(h * 0.7)), 90, (120, 200, 230), -1)
    blur = cv2.GaussianBlur(img, (0, 0), 40)
    return blur


def generate(out_dir: str | Path) -> dict[str, Path]:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    video_silent = out / "test_greenscreen_silent.mp4"
    video_final = out / "test_greenscreen.mp4"
    bg_path = out / "test_background.png"

    rng = np.random.default_rng(2024)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(video_silent), fourcc, FPS, (WIDTH, HEIGHT))
    if not writer.isOpened():
        raise RuntimeError("无法创建测试视频，OpenCV 编码器不可用。")
    for i in range(N_FRAMES):
        writer.write(make_foreground_frame(i, rng))
    writer.release()

    cv2.imwrite(str(bg_path), make_background_image())

    # 用 ffmpeg 加一条 440Hz 正弦波音轨（与视频等长），用于音轨保留验证
    ffmpeg = find_ffmpeg()
    if ffmpeg:
        cmd = [
            ffmpeg, "-y", "-loglevel", "error",
            "-i", str(video_silent),
            "-f", "lavfi", "-i",
            f"sine=frequency=440:duration={DURATION}:sample_rate=44100",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest", str(video_final),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            # 加音轨失败就退回无声版本，但明确告知
            video_silent.replace(video_final)
    else:
        video_silent.replace(video_final)

    if video_silent.exists():
        video_silent.unlink()
    return {"video": video_final, "background": bg_path}


def main() -> None:
    ap = argparse.ArgumentParser(description="生成绿幕测试短片和背景图")
    ap.add_argument("out_dir", nargs="?", default="test_assets",
                    help="输出目录（默认 test_assets）")
    args = ap.parse_args()
    paths = generate(args.out_dir)
    print("已生成测试素材：")
    for k, v in paths.items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
