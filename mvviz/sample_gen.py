"""生成程序样片：平移方块 + 短暂遮挡 + 一次画面切换.

输出（默认写到 ./sample_output/）:
  source.mov          无损母版（ffmpeg huffyuv / qtrle 类，作为“同一份素材”）
  ground_truth.json   程序预设的真实物体运动（逐帧几何，供比对）
  intra.mp4           只用画内编码（每帧都是 I/intra，无运动向量）
  inter.mp4           带前后参考（含 P/B 帧，B 帧同时有过去与未来参考）

两版 mp4 由同一份 source.mov 编码，保证可以停在同一个源画面并排检查。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

FPS = 30
WIDTH, HEIGHT = 640, 360
FRAME_COUNT = 240          # 8.0 秒，符合“十秒内”
SCENE_CUT_FRAME = 144      # 对齐 GOP 边界(keyint=24)，切换帧自然成为 IDR/I 帧
OCCLUDER = dict(x0=250, x1=330, y0=0, y1=HEIGHT, first=55, last=74)

# 方向约定（与 ffmpeg AVMotionVector 一致）:
#   向量从当前块指向参考块；motion_x>0 表示参考块在右侧，即内容向左移动。
#   物体视觉位移向右 -> 速度 vx>0 -> 期望运动向量为 -vx（像素/帧）。


@dataclass
class Rect:
    """轴对齐方块（像素，含边界）。"""

    name: str
    color: tuple[int, int, int]
    x0: float
    y0: float
    w: int
    h: int
    vx: float                  # 视觉速度，像素/帧，向右为正
    vy: float
    is_occluder: bool = False

    def box_at(self, frame: int) -> tuple[int, int, int, int]:
        x = round(self.x0 + self.vx * frame)
        y = round(self.y0 + self.vy * frame)
        return x, y, x + self.w, y + self.h


def _build_objects() -> list[Rect]:
    return [
        # 蓝色方块：匀速向右平移，全程在画面内
        Rect("blue_square", (60, 120, 230), x0=40, y0=70, w=56, h=56, vx=2.0, vy=0.0),
        # 红色方块：向右下斜向平移
        Rect("red_square", (220, 70, 70), x0=80, y0=210, w=48, h=48, vx=1.5, vy=0.8),
        # 灰色遮挡条：短暂从左向右扫过画面中段（自身也是平移物体）
        Rect(
            "occluder_bar", (110, 110, 110),
            x0=OCCLUDER["x0"], y0=OCCLUDER["y0"],
            w=OCCLUDER["x1"] - OCCLUDER["x0"], h=OCCLUDER["y1"] - OCCLUDER["y0"],
            vx=3.0, vy=0.0, is_occluder=True,
        ),
        # 画面切换后出现的绿色方块：向左平移
        Rect("green_square", (70, 190, 90), x0=520, y0=140, w=64, h=64, vx=-2.5, vy=0.0),
    ]


def _background(frame: int) -> np.ndarray:
    """棋盘格静止背景；切换后换另一配色与格子尺寸，表示另一场景。"""
    img = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    if frame < SCENE_CUT_FRAME:
        cell, c_a, c_b = 32, (232, 232, 232), (205, 205, 205)
    else:
        cell, c_a, c_b = 24, (214, 226, 235), (188, 205, 218)
    ys = np.arange(HEIGHT) // cell
    xs = np.arange(WIDTH) // cell
    grid = (ys[:, None] + xs[None, :]) % 2
    img[grid == 0] = c_a
    img[grid == 1] = c_b
    return img


def _paint(img: np.ndarray, box: tuple[int, int, int, int], color: tuple[int, int, int]) -> None:
    x0, y0, x1, y1 = box
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(WIDTH, x1), min(HEIGHT, y1)
    if x1 > x0 and y1 > y0:
        img[y0:y1, x0:x1] = color


def render_frame(frame: int, objects: list[Rect]) -> np.ndarray:
    img = _background(frame)
    # 切换后只画 green_square；切换前画其余三个
    for obj in objects:
        if frame >= SCENE_CUT_FRAME:
            if obj.name != "green_square":
                continue
        else:
            if obj.name == "green_square":
                continue
        if obj.is_occluder and not (OCCLUDER["first"] <= frame <= OCCLUDER["last"]):
            continue
        _paint(img, obj.box_at(frame), obj.color)
    return img


def _visible_objects(frame: int, objects: list[Rect]) -> list[Rect]:
    out = []
    for obj in objects:
        if frame >= SCENE_CUT_FRAME:
            if obj.name == "green_square":
                out.append(obj)
        elif obj.name != "green_square":
            if obj.is_occluder and not (OCCLUDER["first"] <= frame <= OCCLUDER["last"]):
                continue
            out.append(obj)
    return out


def build_ground_truth(objects: list[Rect]) -> dict:
    """逐帧记录每个物体的包围盒与速度，viewer 据此逐块求期望向量。"""
    frames_meta = []
    for f in range(FRAME_COUNT):
        entries = []
        for obj in _visible_objects(f, objects):
            x0, y0, x1, y1 = obj.box_at(f)
            entries.append({
                "name": obj.name,
                "box": [max(0, x0), max(0, y0), min(WIDTH, x1), min(HEIGHT, y1)],
                "vx": obj.vx, "vy": obj.vy,
                "is_occluder": obj.is_occluder,
            })
        frames_meta.append({
            "frame": f,
            "scene_cut": f == SCENE_CUT_FRAME,
            "objects": entries,
        })
    return {
        "fps": FPS,
        "width": WIDTH,
        "height": HEIGHT,
        "frame_count": FRAME_COUNT,
        "scene_cut_frame": SCENE_CUT_FRAME,
        "occluder": OCCLUDER,
        "note": "vx/vy 是物体视觉速度(像素/帧, 向右/下为正); "
                "运动向量约定为块指向参考块, 故期望向量=(-vx,-vy)。",
        "frames": frames_meta,
    }


def _run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"命令失败: {' '.join(cmd)}\n{proc.stderr[-2000:]}")


def generate(out_dir: str | Path = "sample_output") -> dict[str, Path]:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    objects = _build_objects()

    # 1) 逐帧渲染 -> PNG 序列，再由 ffmpeg 封装无损母版
    png_dir = out / "frames_png"
    png_dir.mkdir(exist_ok=True)
    for f in range(FRAME_COUNT):
        Image.fromarray(render_frame(f, objects)).save(png_dir / f"f{f:04d}.png")

    source = out / "source.mov"
    _run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-framerate", str(FPS), "-i", str(png_dir / "f%04d.png"),
        "-c:v", "qtrle", "-pix_fmt", "rgb24", str(source),
    ])

    # 2) 同一份素材 -> 纯画内版本（全部 I 帧，无任何帧间参考）
    intra = out / "intra.mp4"
    _run([
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(source),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-g", str(FRAME_COUNT), "-keyint_min", str(FRAME_COUNT),
        "-sc_threshold", "0",
        "-x264-params", "keyint=240:min-keyint=240:scenecut=0:intra-refresh=0:bframes=0",
        "-an", str(intra),
    ])
    # 再强制全 intra：libx264 的 all-intra 调优，确保不出现 P/B
    _run([
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(source),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-tune", "stillimage",
        "-x264-params", "keyint=1:min-keyint=1:scenecut=0:bframes=0",
        "-an", str(intra),
    ])

    # 3) 同一份素材 -> 带前后参考版本（IBBP 结构，B 帧含过去/未来两种向量）
    inter = out / "inter.mp4"
    _run([
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(source),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
        "-g", "24", "-keyint_min", "24", "-sc_threshold", "0",
        "-x264-params",
        "keyint=24:min-keyint=24:scenecut=40:bframes=2:b-adapt=0:b-pyramid=off:ref=4",
        "-an", str(inter),
    ])

    gt_path = out / "ground_truth.json"
    gt_path.write_text(json.dumps(build_ground_truth(objects), ensure_ascii=False))

    # 中间 PNG 序列已封装进无损母版，清理掉
    shutil.rmtree(png_dir, ignore_errors=True)

    return {"source": source, "intra": intra, "inter": inter, "ground_truth": gt_path}


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="生成运动向量查看器所需的程序样片")
    ap.add_argument("-o", "--out", default="sample_output", help="输出目录")
    args = ap.parse_args()
    paths = generate(args.out)
    print("已生成样片：")
    for k, p in paths.items():
        print(f"  {k:12s} {p}")


if __name__ == "__main__":
    main()
