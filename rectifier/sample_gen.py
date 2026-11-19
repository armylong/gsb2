"""自包含样例生成: 平面标签(已知格点 + 不对称箭头 + 边框) 与斜拍照片。

不依赖字体文件 (仅用 OpenCV 内置 Hershey 字体)、在线服务或外部图片。
所有输出由固定随机种子决定, 删除后重新生成完全一致, 角点记录在 JSON 中可恢复。
"""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

from . import geometry as geo

LABEL_W, LABEL_H = 640, 420
PHOTO_W, PHOTO_H = 1200, 900

# 斜拍后标签四角在照片中的位置 (TL, TR, BR, BL), 固定且可恢复
PHOTO_CORNERS = [
    [338.0, 132.0],
    [845.0, 196.0],
    [878.0, 706.0],
    [292.0, 628.0],
]

GRID_COLS, GRID_ROWS = 7, 5
GRID_MARGIN_X, GRID_MARGIN_Y = 80.0, 70.0

_SEED = 20261120


def grid_points() -> list[tuple[float, float]]:
    """标签上的已知格点 (标签坐标系, 像素中心原点)。"""
    xs = np.linspace(GRID_MARGIN_X, LABEL_W - 1 - GRID_MARGIN_X, GRID_COLS)
    ys = np.linspace(GRID_MARGIN_Y, LABEL_H - 1 - GRID_MARGIN_Y, GRID_ROWS)
    return [(float(x), float(y)) for y in ys for x in xs]


def make_label() -> tuple[np.ndarray, list[tuple[float, float]]]:
    """生成平面标签图, 返回 (图像, 格点列表)。"""
    img = np.full((LABEL_H, LABEL_W, 3), 245, np.uint8)
    # 边框
    cv2.rectangle(img, (6, 6), (LABEL_W - 7, LABEL_H - 7), (20, 20, 20), 3)
    # 不对称红色箭头: 从左下指向右上, 用于肉眼辨认方向
    cv2.arrowedLine(
        img, (110, 320), (320, 110), (0, 0, 230), 12, tipLength=0.18
    )
    # 左下角黑色方块, 进一步打破对称
    cv2.rectangle(img, (30, LABEL_H - 70), (80, LABEL_H - 20), (0, 0, 0), -1)
    # 标签编号文字 (OpenCV 内置字体, 无需字体文件)
    cv2.putText(
        img, "LABEL-01", (LABEL_W - 220, LABEL_H - 30),
        cv2.FONT_HERSHEY_SIMPLEX, 1.0, (40, 40, 40), 2, cv2.LINE_AA,
    )
    # 已知格点: 深色实心圆 + 浅色网格线
    pts = grid_points()
    for x, y in pts:
        cv2.circle(img, (int(round(x)), int(round(y))), 6, (200, 200, 200), 1)
    for x, y in pts:
        cv2.circle(img, (int(round(x)), int(round(y))), 4, (10, 10, 10), -1)
    return img, pts


def make_photo() -> tuple[np.ndarray, list[list[float]]]:
    """把标签透视贴到带渐变与噪声的背景上, 模拟斜拍。返回 (照片, 四角)。"""
    rng = np.random.default_rng(_SEED)
    yy, xx = np.mgrid[0:PHOTO_H, 0:PHOTO_W].astype(np.float32)
    base = 90.0 + 50.0 * (xx / PHOTO_W) + 30.0 * (yy / PHOTO_H)
    photo = np.dstack([base * 0.90, base, np.minimum(base * 1.05, 255.0)])
    photo += rng.normal(0.0, 4.0, photo.shape)
    photo = np.clip(photo, 0, 255).astype(np.uint8)

    label, _ = make_label()
    H = geo.perspective_transform(
        geo.dst_rect(LABEL_W, LABEL_H), np.array(PHOTO_CORNERS, dtype=np.float64)
    )
    warped = cv2.warpPerspective(label, H, (PHOTO_W, PHOTO_H))
    mask = cv2.warpPerspective(
        np.full((LABEL_H, LABEL_W), 255, np.uint8), H, (PHOTO_W, PHOTO_H)
    )
    photo[mask > 0] = warped[mask > 0]
    return photo, [list(c) for c in PHOTO_CORNERS]


def ensure_sample(directory) -> dict:
    """在 directory 下生成样例文件 (幂等, 内容确定), 返回各文件路径。"""
    d = Path(directory)
    d.mkdir(parents=True, exist_ok=True)
    label, grid = make_label()
    photo, corners = make_photo()

    label_path = d / "sample_label.png"
    photo_path = d / "sample_photo.png"
    meta_path = d / "sample_meta.json"

    cv2.imwrite(str(label_path), label)
    cv2.imwrite(str(photo_path), photo)
    meta = {
        "label_size": [LABEL_W, LABEL_H],
        "photo_size": [PHOTO_W, PHOTO_H],
        "corners": {"TL": corners[0], "TR": corners[1], "BR": corners[2], "BL": corners[3]},
        "grid_points": [[x, y] for x, y in grid],
    }
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"label": label_path, "photo": photo_path, "meta": meta_path}
