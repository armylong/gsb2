"""生成自带答案的测试片:

- clean.mkv  : 无瑕疵的参考片(ground truth, 用于计算参考误差)
- defect.mkv : 同一内容,但固定行带被注入横向撕裂/噪声瑕疵,并带正弦音轨

内容包含两个镜头(第 3 秒处硬切),便于验证"时域参考不跨镜头"。
"""
from __future__ import annotations

import math
import os
import struct
import wave

import cv2
import numpy as np

from .pipeline import encode_lossless

W, H, FPS, SECONDS = 640, 360, 30, 6
BAND_Y0, BAND_Y1 = 168, 184          # 瑕疵带(导出/核对时以此为默认选区)
CUT_FRAME = 3 * FPS                  # 镜头硬切位置


def _clean_frame(i: int) -> np.ndarray:
    t = i / FPS
    img = np.zeros((H, W, 3), np.uint8)
    if i < CUT_FRAME:
        # 镜头1: 渐变背景 + 弹跳的圆 + 横向滚动亮条
        grad = np.linspace(30, 120, H, dtype=np.uint8)[:, None]
        img[:] = np.dstack([grad, np.full_like(grad, 60), 255 - grad])
        cx = int(W / 2 + 200 * math.sin(t * 2.0))
        cy = int(H / 2 + 100 * math.sin(t * 3.1))
        cv2.circle(img, (cx, cy), 40, (0, 255, 255), -1)
        x = int((t * 160) % (W + 120)) - 60
        cv2.rectangle(img, (x, 0), (x + 24, H), (200, 200, 200), -1)
    else:
        # 镜头2: 完全不同的场景 —— 深色底 + 移动方块 + 网格
        img[:] = (15, 25, 40)
        for gx in range(0, W, 40):
            cv2.line(img, (gx, 0), (gx, H), (35, 45, 60), 1)
        for gy in range(0, H, 40):
            cv2.line(img, (0, gy), (W, gy), (35, 45, 60), 1)
        bx = int(60 + (t - 3) * 120) % (W - 80)
        by = int(H / 2 + 120 * math.sin((t - 3) * 1.7))
        cv2.rectangle(img, (bx, by - 30), (bx + 80, by + 30), (80, 200, 120), -1)
    cv2.putText(img, f"frame {i:04d}", (10, H - 12),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
    return img


def _inject_defect(frame: np.ndarray, i: int, rng: np.random.Generator) -> np.ndarray:
    """在固定行带上制造'撕裂+闪烁'瑕疵:内容横向错位并叠加噪点。"""
    out = frame.copy()
    band = out[BAND_Y0:BAND_Y1]
    shift = 37 + (i % 5) * 3
    torn = np.roll(band, shift, axis=1)
    noise = rng.integers(0, 90, band.shape, dtype=np.uint8)
    flicker = 40 if i % 2 == 0 else 0
    out[BAND_Y0:BAND_Y1] = cv2.add(torn, noise) // 2 + flicker
    return out


def _write_tone(path: str) -> None:
    """440Hz 正弦音轨,验证'导出后音轨保留'。"""
    sr = 44100
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        for n in range(sr * SECONDS):
            v = int(12000 * math.sin(2 * math.pi * 440 * n / sr))
            w.writeframesraw(struct.pack("<h", v))


def generate(outdir: str) -> dict:
    os.makedirs(outdir, exist_ok=True)
    clean = os.path.join(outdir, "clean.mkv")
    defect = os.path.join(outdir, "defect.mkv")
    tone = os.path.join(outdir, "tone.wav")
    rng = np.random.default_rng(20261121)

    n = FPS * SECONDS
    clean_frames = [_clean_frame(i) for i in range(n)]
    encode_lossless(iter(clean_frames), clean, FPS, (W, H))
    _write_tone(tone)
    defect_frames = (_inject_defect(f, i, rng) for i, f in enumerate(clean_frames))
    encode_lossless(defect_frames, defect, FPS, (W, H), audio_src=tone)
    return {"clean": clean, "defect": defect, "tone": tone,
            "band": (BAND_Y0, BAND_Y1), "cut_frame": CUT_FRAME,
            "fps": FPS, "frames": n}


if __name__ == "__main__":
    import json
    print(json.dumps(generate("samples"), indent=2))
