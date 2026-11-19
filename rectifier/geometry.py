"""平面四边形透视校正的几何核心。

纯 numpy / opencv 实现, 不依赖 GUI, 可独立测试。

坐标约定:
- 所有像素坐标以左上角像素中心为原点, x 向右, y 向下。
- 输出图 W x H 的四个角对应像素中心 (0,0) (W-1,0) (W-1,H-1) (0,H-1),
  因此 warpPerspective(dsize=(W,H)) 的输出恰好是 W 列 H 行, 不多一行不少一列。
- 四角顺序固定为 TL(左上) TR(右上) BR(右下) BL(左下), 按用户点击顺序登记,
  绝不根据点击位置悄悄交换。
"""
from __future__ import annotations

import cv2
import numpy as np

CORNER_NAMES = ("TL", "TR", "BR", "BL")

MIN_QUAD_AREA = 100.0      # 像素^2, 小于此面积拒绝
MIN_TRIANGLE_AREA = 20.0   # 任一由连续三角构成的三角形面积小于此值视为近共线
MAX_COND = 1.0e8           # 单应矩阵条件数上限, 超过视为映射不稳定


def dst_rect(width: float, height: float) -> np.ndarray:
    """输出矩形四角 (TL,TR,BR,BL), 角点落在像素中心上。"""
    w, h = float(width), float(height)
    return np.array(
        [[0.0, 0.0], [w - 1.0, 0.0], [w - 1.0, h - 1.0], [0.0, h - 1.0]],
        dtype=np.float64,
    )


def _cross2d(u: np.ndarray, v: np.ndarray) -> float:
    return float(u[0] * v[1] - u[1] * v[0])


def signed_area(pts) -> float:
    p = np.asarray(pts, dtype=np.float64)
    return 0.5 * float(
        np.sum(p[:, 0] * np.roll(p[:, 1], -1) - np.roll(p[:, 0], -1) * p[:, 1])
    )


def corner_cross_signs(pts) -> list[float]:
    """每个顶点处相邻两边的叉积, 同号为凸, 异号为自交叉/凹陷。"""
    p = np.asarray(pts, dtype=np.float64)
    signs = []
    for i in range(4):
        a, b, c = p[i], p[(i + 1) % 4], p[(i + 2) % 4]
        signs.append(_cross2d(b - a, c - b))
    return signs


def perspective_transform(src, dst) -> np.ndarray:
    """四点透视变换 (getPerspectiveTransform 要求 CV_32F 输入)。"""
    return cv2.getPerspectiveTransform(
        np.asarray(src, dtype=np.float32).reshape(4, 2),
        np.asarray(dst, dtype=np.float32).reshape(4, 2),
    ).astype(np.float64)


def validate_quad(pts) -> tuple[bool, str]:
    """检查四边形是否可用于稳定校正。返回 (是否有效, 原因)。"""
    p = np.asarray(pts, dtype=np.float64)
    if p.shape != (4, 2):
        return False, "需要恰好 4 个角点"
    if not np.all(np.isfinite(p)):
        return False, "角点坐标非法"

    signs = corner_cross_signs(p)
    if not (all(s > 1e-9 for s in signs) or all(s < -1e-9 for s in signs)):
        return False, "四边形自交叉或凹陷 (请按 左上→右上→右下→左下 顺序取角)"

    area = abs(signed_area(p))
    if area < MIN_QUAD_AREA:
        return False, f"选区面积过小 ({area:.1f} px²)"

    tri = min(
        abs(0.5 * _cross2d(p[(i + 1) % 4] - p[i], p[(i + 2) % 4] - p[(i + 1) % 4]))
        for i in range(4)
    )
    if tri < MIN_TRIANGLE_AREA:
        return False, "存在近共线角点, 映射不可靠"

    H = perspective_transform(p, dst_rect(64, 64))
    cond = float(np.linalg.cond(H))
    if not np.isfinite(cond) or cond > MAX_COND:
        return False, f"映射数值不稳定 (条件数 {cond:.2e})"

    return True, ""


def homography(corners, width: int, height: int) -> np.ndarray:
    """源图四角 -> 输出矩形的单应矩阵 (3x3)。"""
    src = np.asarray(corners, dtype=np.float64)
    return perspective_transform(src, dst_rect(width, height))


def warp(image_bgr: np.ndarray, corners, width: int, height: int) -> np.ndarray:
    """生成真实校正图, 输出恰好 width x height 像素。"""
    H = homography(corners, width, height)
    return cv2.warpPerspective(
        image_bgr,
        H,
        (int(width), int(height)),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
    )


def map_points(H: np.ndarray, pts) -> np.ndarray:
    """用单应矩阵映射点集, 返回 Nx2。"""
    arr = np.asarray(pts, dtype=np.float64).reshape(-1, 1, 2)
    out = cv2.perspectiveTransform(arr, np.asarray(H, dtype=np.float64))
    return out.reshape(-1, 2)


def invert(H: np.ndarray) -> np.ndarray:
    return np.linalg.inv(np.asarray(H, dtype=np.float64))


def inside_quad(corners, p, tol: float = 0.25) -> bool:
    """点是否在四边形内 (边界算在内, tol 为像素容差)。"""
    quad = np.asarray(corners, dtype=np.float32)
    dist = cv2.pointPolygonTest(quad, (float(p[0]), float(p[1])), True)
    return dist >= -tol


def inside_output(u: float, v: float, width: int, height: int, tol: float = 0.5) -> bool:
    """校正图坐标是否落在 [0,W-1]x[0,H-1] 像素范围内。"""
    return -tol <= u <= width - 1 + tol and -tol <= v <= height - 1 + tol
