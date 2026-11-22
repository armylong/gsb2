"""自带样图:带尺度的直线组 / 闭环 / 交叉+分叉,附理论值供手算核对。

所有样图建议刻度 0.5 µm/px(横竖相同),底部留白画 100 px 比例尺。
"""
from __future__ import annotations

import json
import math
import os

import cv2
import numpy as np

SCALE_UM_PER_PX = 0.5
BAR_PX = 100
THICK = 3


def _canvas(w, h, margin=70):
    img = np.full((h + margin, w, 3), 255, np.uint8)
    return img


def _scale_bar(img, x=40):
    h = img.shape[0]
    y = h - 35
    cv2.line(img, (x, y), (x + BAR_PX, y), (0, 0, 0), 2)
    cv2.line(img, (x, y - 5), (x, y + 5), (0, 0, 0), 2)
    cv2.line(img, (x + BAR_PX, y - 5), (x + BAR_PX, y + 5), (0, 0, 0), 2)
    cv2.putText(img, f"{BAR_PX} px = {BAR_PX * SCALE_UM_PER_PX:g} um",
                (x, y + 22), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1)


def sample_lines():
    """直线组:水平线、斜线、与斜线同起终位移的折弯线。"""
    img = _canvas(560, 360)
    # L1 水平 200 px
    cv2.line(img, (60, 60), (260, 60), (0, 0, 0), THICK)
    # L2 斜线 dx=200, dy=100
    cv2.line(img, (60, 140), (260, 240), (0, 0, 0), THICK)
    # L3 折弯线:同样的 dx=200, dy=100,但走 10 级台阶(每级右20下10)
    x, y = 320, 140
    pts = [(x, y)]
    for _ in range(10):
        x += 20
        pts.append((x, y))
        y += 10
        pts.append((x, y))
    for a, b in zip(pts, pts[1:]):
        cv2.line(img, a, b, (0, 0, 0), THICK)
    _scale_bar(img)
    meta = {
        "name": "直线组",
        "scale_um_per_px": SCALE_UM_PER_PX,
        "roi": [0, 0, 560, 360],
        "expected": [
            {"label": "L1 水平线", "px": 200.0},
            {"label": "L2 斜线 sqrt(200^2+100^2)", "px": math.hypot(200, 100)},
            {"label": "L3 折弯线 200+100(与 L2 同起终位移)", "px": 300.0},
        ],
        "note": "L2 与 L3 起终位移相同,但路径不同:斜线 223.6 px,折弯线 300 px。",
    }
    return img, meta


def sample_loop():
    """闭环:圆,无端点,也应能被选中并测长。"""
    img = _canvas(400, 360)
    cv2.circle(img, (200, 170), 80, (0, 0, 0), THICK)
    _scale_bar(img)
    meta = {
        "name": "闭环",
        "scale_um_per_px": SCALE_UM_PER_PX,
        "roi": [0, 0, 400, 360],
        "expected": [
            {"label": "圆周长 2*pi*80", "px": 2 * math.pi * 80},
        ],
        "note": "闭环没有端点,测量的是沿骨架一圈的长度。",
    }
    return img, meta


def sample_crossing():
    """交叉 + 真分叉:X 形交叉(四向)与一个 T 形分叉。"""
    img = _canvas(560, 300)
    # X 交叉,中心 (160,140),四臂长度 100/120(横)、80/90(纵斜向)
    cv2.line(img, (60, 40), (260, 240), (0, 0, 0), THICK)   # 主对角线
    cv2.line(img, (260, 40), (60, 240), (0, 0, 0), THICK)   # 副对角线
    # T 分叉:横线止于竖线(度3),不是穿过
    cv2.line(img, (420, 40), (420, 240), (0, 0, 0), THICK)  # 竖线 200
    cv2.line(img, (320, 140), (420, 140), (0, 0, 0), THICK) # 横臂 100
    _scale_bar(img)
    diag = math.hypot(200, 200)
    meta = {
        "name": "交叉与分叉",
        "scale_um_per_px": SCALE_UM_PER_PX,
        "roi": [0, 0, 560, 300],
        "expected": [
            {"label": "X 每条对角线 sqrt(200^2+200^2)", "px": diag},
            {"label": "T 竖线上段", "px": 100.0},
            {"label": "T 竖线下段", "px": 100.0},
            {"label": "T 横臂", "px": 100.0},
        ],
        "note": "X 是疑似交叉(度4),默认按最直配对成两条对角线,可切换配对;"
                "T 是真分叉(度3),三条支各自成段。",
    }
    return img, meta


SAMPLES = {
    "lines": sample_lines,
    "loop": sample_loop,
    "crossing": sample_crossing,
}


def save_samples(directory: str) -> list:
    """把样图和理论值写到目录,返回文件路径列表。"""
    os.makedirs(directory, exist_ok=True)
    written = []
    for key, fn in SAMPLES.items():
        img, meta = fn()
        png = os.path.join(directory, f"sample_{key}.png")
        cv2.imwrite(png, img)
        written.append(png)
        js = os.path.join(directory, f"sample_{key}_expected.json")
        with open(js, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        written.append(js)
    return written


if __name__ == "__main__":
    for p in save_samples("samples"):
        print("written:", p)
