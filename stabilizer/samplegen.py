"""合成测试样例生成器。

生成 720p/30fps/12s、含一次硬切的 mp4, 包含:
- 定位标记 (网格 + 十字标) 与逐帧帧号
- 已知的平移/旋转高频抖动
- 缓慢的有意运镜 (线性平移, 平滑必须保留的低频成分)
- 一次硬切 (两镜头纹理/底色完全不同)
- 一条正弦音频用于核对音画同步

真实抖动答案只写入 ground_truth.json; 防抖主流程不读取该文件。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np

WIDTH, HEIGHT, FPS = 1280, 720, 30
SHOT_SPLIT = 200                      # 硬切首帧
FRAME_COUNT = 360                     # 12 秒, 未超 15s 上限
CANVAS_W = 1600                       # 虚拟大场景宽度, 给水平运镜留余量
CANVAS_H = 1080                       # 虚拟大场景高度
MARGIN = 120                          # 窗口中心允许的边缘余量(大于抖动+运镜幅度)
SCENE_ZOOM = 1.18                     # 渲染预放大, 保证旋转时窗口四角仍在场景内


def _scene_a(canvas: np.ndarray, rng: np.random.Generator) -> None:
    canvas[:] = (190, 195, 205)        # BGR 浅灰
    for x in range(0, canvas.shape[1], 80):
        cv2.line(canvas, (x, 0), (x, canvas.shape[0]), (120, 120, 130), 2)
    for y in range(0, canvas.shape[0], 80):
        cv2.line(canvas, (0, y), (canvas.shape[1], y), (120, 120, 130), 2)
    for _ in range(60):
        x, y = rng.integers(0, canvas.shape[1]), rng.integers(0, canvas.shape[0])
        r = int(rng.integers(8, 26))
        color = tuple(int(v) for v in rng.integers(40, 160, size=3))
        cv2.circle(canvas, (x, y), r, color, -1)
    for gx in range(120, canvas.shape[1], 240):
        for gy in range(120, canvas.shape[0], 240):
            cv2.drawMarker(canvas, (gx, gy), (0, 0, 220),
                           cv2.MARKER_CROSS, 34, 3)


def _scene_b(canvas: np.ndarray, rng: np.random.Generator) -> None:
    canvas[:] = (90, 70, 55)           # 深棕, 与镜头 A 差异明显
    # 双向梯度充足的网格 (横竖线条密度一致, 避免单方向纹理导致跟踪偏差)
    for x in range(0, canvas.shape[1], 64):
        cv2.line(canvas, (x, 0), (x, canvas.shape[0]), (170, 140, 110), 2)
    for y in range(0, canvas.shape[0], 64):
        cv2.line(canvas, (0, y), (canvas.shape[1], y), (170, 140, 110), 2)
    # 棋盘格块: 强角点特征, 两个方向都可跟踪
    cell = 40
    for gy in range(40, canvas.shape[0] - cell, cell * 3):
        for gx in range(40, canvas.shape[1] - cell, cell * 3):
            for dy in range(2):
                for dx in range(2):
                    if (dx + dy) % 2 == 0:
                        cv2.rectangle(canvas,
                                      (gx + dx * cell, gy + dy * cell),
                                      (gx + (dx + 1) * cell - 1,
                                       gy + (dy + 1) * cell - 1),
                                      (210, 200, 180), -1)
    for _ in range(70):
        x, y = rng.integers(0, canvas.shape[1]), rng.integers(0, canvas.shape[0])
        r = int(rng.integers(6, 20))
        color = tuple(int(v) for v in rng.integers(120, 240, size=3))
        cv2.circle(canvas, (x, y), r, color, -1)
    for gx in range(96, canvas.shape[1], 200):
        for gy in range(96, canvas.shape[0], 200):
            cv2.drawMarker(canvas, (gx, gy), (0, 230, 230),
                           cv2.MARKER_TILTED_CROSS, 30, 3)


def camera_path(i: int, shot: int) -> dict:
    """已知的相机窗口变换 (窗口中心在场景中的位置 + 旋转)。"""
    if shot == 0:
        n = SHOT_SPLIT
        t = i / max(1, n - 1)
        intentional = {
            "tx": 110.0 * t,                 # 缓慢右移 110px
            "ty": -40.0 * t,                # 缓慢上移 40px
            "angle": 0.0,
        }
    else:
        n = FRAME_COUNT - SHOT_SPLIT
        t = (i - SHOT_SPLIT) / max(1, n - 1)
        intentional = {
            "tx": 90.0 * t,
            "ty": 55.0 * t,
            "angle": 2.5 * t,               # 缓慢旋转 2.5 度
        }
    # 高频抖动: 两个频率叠加的正弦 + 轻微随机扰动
    jitter = {
        "tx": 5.5 * np.sin(2 * np.pi * 2.1 * i / FPS)
              + 2.0 * np.sin(2 * np.pi * 5.3 * i / FPS),
        "ty": 4.5 * np.sin(2 * np.pi * 1.7 * i / FPS + 1.2)
              + 1.8 * np.sin(2 * np.pi * 4.6 * i / FPS),
        "angle": 0.85 * np.sin(2 * np.pi * 2.6 * i / FPS + 0.5)
                 + 0.3 * np.sin(2 * np.pi * 6.1 * i / FPS),
    }
    return {
        "intentional": intentional,
        "jitter": jitter,
        "tx": intentional["tx"] + jitter["tx"],
        "ty": intentional["ty"] + jitter["ty"],
        "angle": intentional["angle"] + jitter["angle"],
    }


def _window_warp(cx: float, cy: float, angle_deg: float) -> np.ndarray:
    """场景坐标 -> 窗口(帧)坐标的 2x3 仿射。

    仿射链: 场景坐标平移到以场景中心为原点 -> 预放大 SCENE_ZOOM
    -> 旋转 -> 平移, 使场景中心对准窗口中心 (cx, cy)。
    预放大保证窗口四角永远落在场景内容内, 源片自身不带黑边。
    """
    a = np.radians(angle_deg)
    c, s = np.cos(a), np.sin(a)
    scene_center = np.array([CANVAS_W / 2.0, CANVAS_H / 2.0])
    rot_zoom = np.array([[c, -s], [s, c]]) * SCENE_ZOOM
    t = np.array([cx, cy]) - rot_zoom @ scene_center
    return np.hstack([rot_zoom, t.reshape(2, 1)]).astype(np.float64)


def generate(out_dir: str | Path, seed: int = 20261118) -> dict:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    canvas_a = np.zeros((CANVAS_H, CANVAS_W, 3), np.uint8)
    canvas_b = np.zeros((CANVAS_H, CANVAS_W, 3), np.uint8)
    _scene_a(canvas_a, rng)
    _scene_b(canvas_b, rng)

    gt_frames = []
    with tempfile.TemporaryDirectory() as td:
        silent = Path(td) / "silent.mp4"
        writer = cv2.VideoWriter(str(silent),
                                 cv2.VideoWriter_fourcc(*"mp4v"),
                                 FPS, (WIDTH, HEIGHT))
        for i in range(FRAME_COUNT):
            shot = 0 if i < SHOT_SPLIT else 1
            path = camera_path(i, shot)
            cx = WIDTH / 2.0 + path["tx"]
            cy = CANVAS_H / 2.0 + path["ty"]
            warp = _window_warp(cx, cy, path["angle"])
            canvas = canvas_a if shot == 0 else canvas_b
            frame = cv2.warpAffine(canvas, warp, (WIDTH, HEIGHT),
                                   flags=cv2.INTER_LINEAR,
                                   borderMode=cv2.BORDER_CONSTANT,
                                   borderValue=(0, 0, 0))
            # 定位标记角标 + 帧号
            cv2.rectangle(frame, (0, 0), (250, 44), (0, 0, 0), -1)
            cv2.putText(frame, f"shot{shot} f{i:03d}", (10, 31),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2,
                        cv2.LINE_AA)
            writer.write(frame)
            gt_frames.append({
                "frame": i, "shot": shot,
                "intentional": {k: round(float(v), 4)
                                for k, v in path["intentional"].items()},
                "jitter": {k: round(float(v), 4)
                           for k, v in path["jitter"].items()},
                "window_center": [round(float(cx), 3), round(float(cy), 3)],
            })
        writer.release()

        video = out_dir / "sample_input.mp4"
        # 正弦音频 (440Hz, 与视频严格等长), AAC 192k
        cmd = [
            "ffmpeg", "-y", "-v", "error",
            "-i", str(silent),
            "-f", "lavfi", "-i",
            f"sine=frequency=440:duration={FRAME_COUNT / FPS:.3f}:sample_rate=44100",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium",
            "-b:v", "6m", "-c:a", "aac", "-b:a", "192k", "-shortest",
            "-movflags", "+faststart", str(video),
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:
            raise RuntimeError(f"样例编码失败: {res.stderr[:300]}")

    ground_truth = {
        "description": "合成防抖测试样例的已知答案; 仅 verify.py 可读取",
        "seed": seed,
        "video": {"width": WIDTH, "height": HEIGHT, "fps": FPS,
                  "frame_count": FRAME_COUNT,
                  "duration_sec": FRAME_COUNT / FPS,
                  "audio": "440Hz sine, AAC mono 44.1kHz"},
        "hard_cut_frame": SHOT_SPLIT,
        "jitter_model": "sin(2.1/1.7/2.6 Hz) + sin(5.3/4.6/6.1 Hz)",
        "intentional_motion": {
            "shot0": {"tx_span_px": 110.0, "ty_span_px": -40.0,
                      "angle_span_deg": 0.0},
            "shot1": {"tx_span_px": 90.0, "ty_span_px": 55.0,
                      "angle_span_deg": 2.5},
        },
        "frames": gt_frames,
    }
    gt_path = out_dir / "ground_truth.json"
    gt_path.write_text(json.dumps(ground_truth, ensure_ascii=False, indent=1),
                       encoding="utf-8")
    return {"video": str(video), "ground_truth": str(gt_path),
            "frame_count": FRAME_COUNT, "cut": SHOT_SPLIT}


def main() -> None:
    ap = argparse.ArgumentParser(description="生成防抖合成测试样例")
    ap.add_argument("out_dir", help="输出目录")
    ap.add_argument("--seed", type=int, default=20261118)
    args = ap.parse_args()
    result = generate(args.out_dir, args.seed)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
