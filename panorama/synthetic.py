"""自生成带已知真值的宽幅测试场景，无需用户拍照。

生成内容：
1. 一张含多种纹理（渐变、棋盘、随机块、几何形状、黑色实景）的宽幅底图；
2. 从底图按 *已知* 单应裁出 3~6 张重叠照片（含轻微亮度变化）；
3. 一张与场景完全不相干的图片；
4. 真值：每张照片在底图坐标系中的单应、帧位置、控制点与错误控制点。

真值约定：H_photo_to_world 把照片图像坐标映射到底图坐标。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from .config import Config


@dataclass
class SyntheticFrame:
    name: str
    image: np.ndarray
    H_to_world: np.ndarray       # 照片 -> 底图（真值）
    brightness: float
    x: int
    y: int
    w: int
    h: int


def _base_world(width: int = 2400, height: int = 700, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    canvas = np.zeros((height, width, 3), np.uint8)

    # 1) 水平 + 垂直柔和渐变（低纹理区，考验匹配鲁棒性）
    grad_x = np.linspace(40, 210, width, dtype=np.uint8)[None, :].repeat(height, 0)
    grad_y = np.linspace(30, 180, height, dtype=np.uint8)[:, None].repeat(width, 1)
    canvas[..., 0] = grad_x
    canvas[..., 1] = grad_y
    canvas[..., 2] = ((grad_x.astype(int) + grad_y) // 2).astype(np.uint8)

    # 2) 棋盘格（高纹理、规则重复，考验错误匹配拒绝）
    tile = 60
    for r in range(height // tile + 1):
        for c in range(width // tile + 1):
            if (r + c) % 2 == 0:
                y0, y1 = r * tile, min((r + 1) * tile, height)
                x0, x1 = c * tile, min((c + 1) * tile, width)
                color = (200, 120, 60) if (r * 7 + c * 3) % 3 else (70, 90, 160)
                cv2.rectangle(canvas, (x0, y0), (x1, y1), color, -1)

    # 3) 随机色块（独特纹理，保证存在可匹配特征）
    for _ in range(220):
        x = int(rng.integers(0, width - 80))
        y = int(rng.integers(0, height - 80))
        rw, rh = int(rng.integers(15, 70)), int(rng.integers(15, 70))
        color = tuple(int(v) for v in rng.integers(0, 255, 3))
        cv2.rectangle(canvas, (x, y), (x + rw, y + rh), color, -1)

    # 4) 圆 / 多边形 / 线条
    for _ in range(60):
        cx, cy = int(rng.integers(0, width)), int(rng.integers(0, height))
        rad = int(rng.integers(12, 45))
        color = tuple(int(v) for v in rng.integers(0, 255, 3))
        cv2.circle(canvas, (cx, cy), rad, color, int(rng.integers(2, 6)))
    for _ in range(40):
        p1 = (int(rng.integers(0, width)), int(rng.integers(0, height)))
        p2 = (int(rng.integers(0, width)), int(rng.integers(0, height)))
        cv2.line(canvas, p1, p2,
                 tuple(int(v) for v in rng.integers(0, 255, 3)),
                 int(rng.integers(1, 4)))

    # 5) 黑色实景块：真实内容就是纯黑，必须在拼接后保留，不能被当空洞
    cv2.rectangle(canvas, (180, 420), (420, 640), (0, 0, 0), -1)
    cv2.rectangle(canvas, (180, 420), (420, 640), (255, 255, 255), 3)
    cv2.putText(canvas, "REAL BLACK", (200, 540),
                cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)
    cv2.rectangle(canvas, (1500, 60), (1760, 260), (0, 0, 0), -1)
    cv2.circle(canvas, (1630, 160), 55, (0, 0, 0), -1)

    # 6) 等间距唯一标记：每个标记内部的点阵编码都不同，
    #    保证任意重叠区都存在不可混淆的独特特征（对抗棋盘重复纹理）
    marker_w, gap = 120, 180
    for k, mx in enumerate(range(60, width - marker_w, gap)):
        my = 90 + (k % 3) * 180
        _draw_unique_marker(canvas, mx, my, marker_w, k)
    return canvas


def _draw_unique_marker(
    canvas: np.ndarray, x: int, y: int, size: int, marker_id: int
) -> None:
    """带白边、黑框和唯一内部点阵的标记。"""
    cv2.rectangle(canvas, (x, y), (x + size, y + size), (255, 255, 255), -1)
    cv2.rectangle(canvas, (x, y), (x + size, y + size), (0, 0, 0), 4)
    cells = 5
    pad = size // 6
    cell = (size - 2 * pad) // cells
    rng = np.random.default_rng(1000 + marker_id)
    bits = rng.integers(0, 2, (cells, cells))
    for r in range(cells):
        for c in range(cells):
            if bits[r, c]:
                x0 = x + pad + c * cell
                y0 = y + pad + r * cell
                cv2.rectangle(
                    canvas, (x0, y0), (x0 + cell - 2, y0 + cell - 2),
                    (0, 0, 0), -1,
                )


def _make_frame(
    world: np.ndarray, x: int, y: int, w: int, h: int,
    brightness: float, jitter: float, rng: np.random.Generator,
) -> tuple[np.ndarray, np.ndarray]:
    """从底图裁一帧，并施加轻微透视扰动与亮度变化。返回 (帧, H帧->底图)。"""
    src = np.array([[0, 0], [w, 0], [w, h], [0, h]], np.float32)
    dst = np.array(
        [
            [x + rng.normal(0, jitter), y + rng.normal(0, jitter)],
            [x + w + rng.normal(0, jitter), y + rng.normal(0, jitter)],
            [x + w + rng.normal(0, jitter), y + h + rng.normal(0, jitter)],
            [x + rng.normal(0, jitter), y + h + rng.normal(0, jitter)],
        ],
        np.float32,
    )
    H_warp = cv2.getPerspectiveTransform(src, dst)  # 帧坐标 -> 底图坐标
    frame = cv2.warpPerspective(
        world, np.linalg.inv(H_warp), (w, h),
        flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT,
    )
    # 轻微亮度变化（乘法 + 小偏移），不改变几何
    frame = np.clip(
        frame.astype(np.float32) * brightness
        + rng.normal(0, 3, frame.shape),
        0, 255,
    ).astype(np.uint8)
    return frame, H_warp.astype(np.float64)


def build_synthetic_scene(
    out_dir: str | Path,
    n_frames: int = 5,
    cfg: Config | None = None,
    overlap_frac: float = 0.45,
    closed_loop: bool = False,
) -> dict:
    """生成测试场景。

    overlap_frac: 相邻帧目标重叠比例（按帧宽）。
    closed_loop:  若为 True，最后一帧回到开头附近，制造首尾重叠闭环。
    """
    cfg = cfg or Config()
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(cfg.synthetic_seed)

    world_w, world_h = 2400, 700
    world = _base_world(world_w, world_h, cfg.synthetic_seed)
    cv2.imwrite(str(out / "world_groundtruth.png"), world)

    frame_w, frame_h = 640, 520
    step = int(round(frame_w * (1.0 - overlap_frac)))
    if closed_loop:
        # 前 n-1 帧向右步进，末帧回到首帧附近并纵向错开，
        # 使首尾形成真实重叠（闭环边），同时保留相邻链接
        xs = [k * step for k in range(n_frames - 1)]
        xs.append(int(step * 0.4))  # 末帧起点靠近首帧
    else:
        # 固定步进，相邻帧重叠比例由 overlap_frac 精确控制
        xs = [k * step for k in range(n_frames)]
    brightness_seq = [0.92, 1.05, 0.97, 1.1, 0.9]

    frames: list[SyntheticFrame] = []
    truth_homog = {}
    for k, x in enumerate(xs):
        y = int(rng.integers(40, max(41, world_h - frame_h - 40)))
        b = brightness_seq[k % len(brightness_seq)]
        img, H = _make_frame(
            world, int(x), y, frame_w, frame_h, b, jitter=6.0, rng=rng
        )
        name = f"frame_{k}.png"
        cv2.imwrite(str(out / name), img)
        frames.append(
            SyntheticFrame(name, img, H, b, int(x), y, frame_w, frame_h)
        )
        truth_homog[name] = H.tolist()

    # 不相干图片：独立噪声 + 标记，特征与底图无任何对应
    unrelated = rng.integers(0, 255, (frame_h, frame_w, 3), dtype=np.uint8)
    unrelated = cv2.GaussianBlur(unrelated, (7, 7), 0)
    cv2.putText(unrelated, "UNRELATED", (60, 260),
                cv2.FONT_HERSHEY_SIMPLEX, 1.4, (255, 255, 255), 3)
    cv2.imwrite(str(out / "unrelated.png"), unrelated)

    # 控制点真值（相邻帧各 6 个），以及一份故意错误的控制点
    control_true, control_wrong = {}, {}
    for k in range(len(frames) - 1):
        fa, fb = frames[k], frames[k + 1]
        pts_a = np.array(
            [
                [frame_w * 0.55, frame_h * 0.3],
                [frame_w * 0.7, frame_h * 0.55],
                [frame_w * 0.6, frame_h * 0.75],
                [frame_w * 0.85, frame_h * 0.35],
                [frame_w * 0.75, frame_h * 0.8],
                [frame_w * 0.9, frame_h * 0.6],
            ]
        )
        # 经两张帧的真值单应转到同一底图坐标系，再投到 fb 坐标
        world_pts = _apply_h(fa.H_to_world, pts_a)
        pts_b = _apply_h(np.linalg.inv(fb.H_to_world), world_pts)
        control_true[f"{fa.name}|{fb.name}"] = {
            "src": pts_a.tolist(), "dst": pts_b.tolist()
        }
        pts_b_wrong = pts_b.copy()
        pts_b_wrong[:2, 1] += 90  # 前两个点明显偏移 -> 错误控制点
        control_wrong[f"{fa.name}|{fb.name}"] = {
            "src": pts_a.tolist(), "dst": pts_b_wrong.tolist()
        }

    meta = {
        "world": "world_groundtruth.png",
        "world_size": [world_w, world_h],
        "frames": [
            {
                "file": f.name,
                "size": [f.w, f.h],
                "origin": [f.x, f.y],
                "brightness": f.brightness,
                "H_to_world": f.H_to_world.tolist(),
            }
            for f in frames
        ],
        "unrelated": "unrelated.png",
        "control_points_true": control_true,
        "control_points_wrong": control_wrong,
        "note": "H_to_world: 照片图像坐标 -> 底图坐标的真值单应",
    }
    with open(out / "groundtruth.json", "w", encoding="utf-8") as fp:
        json.dump(meta, fp, indent=2)
    return meta


def _apply_h(H: np.ndarray, pts: np.ndarray) -> np.ndarray:
    homog = np.concatenate([pts, np.ones((len(pts), 1))], 1)
    out = (np.asarray(H) @ homog.T).T
    return out[:, :2] / out[:, 2:3]


def load_scene(scene_dir: str | Path) -> dict:
    with open(Path(scene_dir) / "groundtruth.json", encoding="utf-8") as fp:
        return json.load(fp)
