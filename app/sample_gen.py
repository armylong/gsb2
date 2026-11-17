"""生成带帧号的短样例视频与独立核对用的目标位置真值数据。

样例内容(6s, 30fps, 1280x720, 含音频):
- 一个纹理清晰的目标块在静态背景上运动;
- 第 0-59 帧: 平移;
- 第 60-89 帧: 平移 + 放大到 1.25 倍(有限缩放);
- 第 90-119 帧: 目标被灰色块短暂遮挡(真值标记 visible=false);
- 第 120-179 帧: 目标重新出现,继续平移并缓慢缩到 1.15 倍。

真值写在 ground_truth.json,仅供核对,跟踪功能不得读取它。
"""
from __future__ import annotations

import json
import os
import subprocess

import cv2
import numpy as np

W, H, N, FPS = 1280, 720, 180, 30
PATCH_W, PATCH_H = 140, 90
OCCL_START, OCCL_END = 90, 119  # 含端点


def _background() -> np.ndarray:
    rng = np.random.default_rng(11)
    yy, xx = np.mgrid[0:H, 0:W]
    bg = np.zeros((H, W, 3), np.uint8)
    bg[..., 0] = (60 + xx * 60 // W).astype(np.uint8)
    bg[..., 1] = (50 + yy * 50 // H).astype(np.uint8)
    bg[..., 2] = 70
    noise = rng.integers(-12, 13, (H, W, 1)).astype(np.int16)
    bg = np.clip(bg.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    for cx, cy, r, col in [(1050, 150, 60, (90, 140, 200)), (200, 600, 80, (60, 160, 90)),
                           (900, 550, 45, (180, 120, 60))]:
        cv2.circle(bg, (cx, cy), r, col, -1)
    for i in range(6):
        cv2.line(bg, (0, 120 * i), (W, 120 * i + 40), (80, 80, 80), 1)
    return bg


def _patch() -> np.ndarray:
    rng = np.random.default_rng(23)
    p = rng.integers(0, 256, (PATCH_H, PATCH_W, 3), dtype=np.uint8)
    p = cv2.GaussianBlur(p, (3, 3), 0)
    cv2.rectangle(p, (4, 4), (PATCH_W - 5, PATCH_H - 5), (0, 0, 255), 3)
    cv2.circle(p, (PATCH_W // 2, PATCH_H // 2), 18, (0, 255, 255), -1)
    cv2.line(p, (0, 0), (PATCH_W, PATCH_H), (255, 0, 0), 2)
    cv2.putText(p, "ID", (8, PATCH_H - 10), cv2.FONT_HERSHEY_SIMPLEX,
                0.8, (255, 255, 255), 2)
    return p


def _trajectory(f: int):
    """返回 (cx, cy, scale):目标中心与缩放。"""
    cx = 190 + 3.2 * f
    cy = 200 + 1.2 * f
    if f < 60:
        s = 1.0
    elif f < 90:
        s = 1.0 + 0.25 * (f - 59) / 30.0
    elif f < 120:
        s = 1.25
    else:
        s = 1.25 - 0.10 * (f - 119) / 60.0
    return cx, cy, s


def generate(out_dir: str) -> dict:
    os.makedirs(out_dir, exist_ok=True)
    video_path = os.path.join(out_dir, "sample.mp4")
    gt_path = os.path.join(out_dir, "ground_truth.json")
    bg = _background()
    patch = _patch()
    cmd = ["ffmpeg", "-y",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}",
           "-r", str(FPS), "-i", "-",
           "-f", "lavfi", "-i", f"sine=frequency=440:duration={N / FPS}",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
           "-c:a", "aac", "-shortest", video_path]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    gt = []
    for f in range(N):
        frame = bg.copy()
        cx, cy, s = _trajectory(f)
        pw, ph = int(round(PATCH_W * s)), int(round(PATCH_H * s))
        x, y = int(round(cx - pw / 2)), int(round(cy - ph / 2))
        visible = not (OCCL_START <= f <= OCCL_END)
        p = cv2.resize(patch, (pw, ph), interpolation=cv2.INTER_LINEAR)
        frame[y:y + ph, x:x + pw] = p
        if not visible:
            # 灰色遮挡块完全盖住目标(目标在遮挡下继续运动)
            ox0, oy0 = int(cx - pw * 0.75), int(cy - ph * 0.75)
            ox1, oy1 = int(cx + pw * 0.75), int(cy + ph * 0.75)
            cv2.rectangle(frame, (ox0, oy0), (ox1, oy1), (160, 160, 160), -1)
            cv2.rectangle(frame, (ox0, oy0), (ox1, oy1), (120, 120, 120), 2)
        cv2.putText(frame, f"frame {f:03d}", (12, 32),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2)
        proc.stdin.write(frame.tobytes())
        gt.append({"frame": f, "x": x, "y": y, "w": pw, "h": ph, "visible": visible})
    proc.stdin.close()
    if proc.wait() != 0:
        raise RuntimeError("ffmpeg 生成样例失败")
    with open(gt_path, "w") as fp:
        json.dump({"fps": FPS, "frames": N, "width": W, "height": H,
                   "occlusion": [OCCL_START, OCCL_END], "per_frame": gt}, fp, indent=1)
    return {"video": video_path, "ground_truth": gt_path}


if __name__ == "__main__":
    import sys
    out = sys.argv[1] if len(sys.argv) > 1 else "samples"
    print(json.dumps(generate(out), indent=1, ensure_ascii=False))
