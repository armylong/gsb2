"""自带测试数据生成: 同一张轮廓图, 四个波段反差不同。

场景 (256x256, uint16):
  0 背景      —— 深色底
  1 树叶(树冠)—— 圆形斑块, 在 b3/b4 反射强、b1/b2 弱 (近红外型反差)
  2 灰路      —— 斜向条带, 各波段数值接近但有微小差异 (检验「本来就不同还是拉伸问题」)
  3 水体      —— 低反射方块
  4 无值区    —— 左上角圆斑, 所有波段写 0 并标记 nodata
另含一条平缓梯度与固定种子噪声, 使同类内部不是平涂。

输出:
  <outdir>/b1.png ... b4.png   16 位灰度 PNG
  <outdir>/b1.npy ... b4.npy   同内容 numpy
  <outdir>/labels.npy          轮廓标签图 (测试核对用)
  <outdir>/sample_meta.json    测试点期望数值与无值配置
"""

from __future__ import annotations

import json
import os

import numpy as np

WIDTH = HEIGHT = 256
NODATA_VALUE = 0

# 标签编号
LBL_BACKGROUND, LBL_LEAF, LBL_ROAD, LBL_WATER, LBL_NODATA = range(5)
LABEL_NAMES = {
    LBL_BACKGROUND: "background",
    LBL_LEAF: "leaf",
    LBL_ROAD: "gray_road",
    LBL_WATER: "water",
    LBL_NODATA: "nodata",
}

# 各波段各类别的 (基底值, 类别间反差系数); 灰路在四个波段故意只做微小差异
_CLASS_BASE = {
    LBL_BACKGROUND: 1800.0,
    LBL_LEAF: 2600.0,
    LBL_ROAD: 4200.0,
    LBL_WATER: 900.0,
}
# band -> {class: 乘性系数}; 树叶在 b3/b4 抬升, 灰路几乎不变
_BAND_GAIN = {
    "b1": {LBL_BACKGROUND: 1.00, LBL_LEAF: 0.80, LBL_ROAD: 1.00, LBL_WATER: 1.05},
    "b2": {LBL_BACKGROUND: 1.02, LBL_LEAF: 0.95, LBL_ROAD: 1.01, LBL_WATER: 1.00},
    "b3": {LBL_BACKGROUND: 0.98, LBL_LEAF: 0.90, LBL_ROAD: 0.99, LBL_WATER: 0.90},
    "b4": {LBL_BACKGROUND: 1.01, LBL_LEAF: 1.85, LBL_ROAD: 1.02, LBL_WATER: 0.80},
}
BAND_NAMES = ("b1", "b2", "b3", "b4")


def build_labels() -> np.ndarray:
    """生成共享轮廓标签图 (所有波段同轮廓)。"""
    yy, xx = np.mgrid[0:HEIGHT, 0:WIDTH]
    labels = np.full((HEIGHT, WIDTH), LBL_BACKGROUND, dtype=np.uint8)

    # 灰路: 两条对角斜带 (宽 14 像素)
    dist1 = np.abs(xx - yy - 40)
    dist2 = np.abs(xx + yy - 360)
    road = (dist1 < 7) | (dist2 < 7)
    labels[road] = LBL_ROAD

    # 树叶: 三个圆树冠
    for cx, cy, r in ((70, 180, 34), (150, 90, 40), (205, 190, 26)):
        circle = (xx - cx) ** 2 + (yy - cy) ** 2 <= r**2
        labels[circle] = LBL_LEAF

    # 水体: 右下角方块
    labels[205:245, 30:95] = LBL_WATER

    # 无值区: 左上角圆斑
    nodata = (xx - 28) ** 2 + (yy - 28) ** 2 <= 18**2
    labels[nodata] = LBL_NODATA
    return labels


def build_band(name: str, labels: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    yy, xx = np.mgrid[0:HEIGHT, 0:WIDTH]
    gradient = (xx + yy).astype(np.float64) / (WIDTH + HEIGHT) * 260.0
    noise = rng.normal(0.0, 45.0, size=labels.shape)
    out = np.zeros(labels.shape, dtype=np.float64)

    for cls, base in _CLASS_BASE.items():
        mask = labels == cls
        gain = _BAND_GAIN[name][cls]
        out[mask] = base * gain + gradient[mask] * 0.25 + noise[mask]

    # 保证有效像素整体偏移, 不会与 nodata=0 冲突
    out = np.maximum(out, 250.0)
    out[labels == LBL_NODATA] = NODATA_VALUE
    return np.rint(out).astype(np.uint16)


def _class_pixel(labels: np.ndarray, cls: int) -> tuple[int, int]:
    ys, xs = np.nonzero(labels == cls)
    i = len(ys) // 2
    return int(xs[i]), int(ys[i])


def generate_sample_dataset(outdir: str) -> dict:
    """生成全套测试数据并落盘, 返回元数据 dict。"""
    os.makedirs(outdir, exist_ok=True)
    labels = build_labels()
    rng = np.random.default_rng(20261127)

    bands: dict[str, np.ndarray] = {}
    for name in BAND_NAMES:
        band = build_band(name, labels, rng)
        bands[name] = band
        np.save(os.path.join(outdir, f"{name}.npy"), band)
        _save_gray16_png(os.path.join(outdir, f"{name}.png"), band)

    np.save(os.path.join(outdir, "labels.npy"), labels)

    # 测试点: 每类取一个代表像素, 记录四波段原始值
    test_points = []
    for cls in (LBL_BACKGROUND, LBL_LEAF, LBL_ROAD, LBL_WATER, LBL_NODATA):
        x, y = _class_pixel(labels, cls)
        point = {
            "label": LABEL_NAMES[cls],
            "x": x,
            "y": y,
            "values": {name: int(bands[name][y, x]) for name in BAND_NAMES},
        }
        test_points.append(point)

    # 额外指定两个相邻的树叶/灰路像素, 方便逐波段对照
    leaf_x, leaf_y = _class_pixel(labels, LBL_LEAF)
    road_x, road_y = _class_pixel(labels, LBL_ROAD)

    meta = {
        "width": WIDTH,
        "height": HEIGHT,
        "dtype": "uint16",
        "nodata_value": NODATA_VALUE,
        "band_names": list(BAND_NAMES),
        "label_names": LABEL_NAMES,
        "test_points": test_points,
        "leaf_pixel": [leaf_x, leaf_y],
        "road_pixel": [road_x, road_y],
        # 用 b4/b3 做归一化差值时, 树叶应明显为正
        "ndvi_suggested": {"a": "b4", "b": "b3"},
        "denom_eps_suggested": 1e-6,
    }
    with open(os.path.join(outdir, "sample_meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    return meta


def _save_gray16_png(path: str, arr: np.ndarray) -> None:
    from PySide6.QtGui import QImage

    h, w = arr.shape
    image = QImage(arr.tobytes(), w, h, 2 * w, QImage.Format.Format_Grayscale16).copy()
    if not image.save(path, "PNG"):
        raise OSError(f"写入 {path} 失败")
