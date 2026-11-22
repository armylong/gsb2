"""Zhang-Suen 细化:掩膜 → 单像素宽中心线(纯 numpy 向量化实现)。"""
from __future__ import annotations

import cv2
import numpy as np

NEIGH8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def _removable(sk: np.ndarray, x: int, y: int) -> bool:
    """删除 (x,y) 是否保持 3x3 邻域内其余骨架像素的 8 连通性。"""
    pts = []
    for dx, dy in NEIGH8:
        nx, ny = x + dx, y + dy
        if 0 <= ny < sk.shape[0] and 0 <= nx < sk.shape[1] and sk[ny, nx]:
            pts.append((nx, ny))
    if len(pts) <= 1:
        return True
    pset = set(pts)
    seen = {pts[0]}
    stack = [pts[0]]
    while stack:
        cx, cy = stack.pop()
        for dx, dy in NEIGH8:
            q = (cx + dx, cy + dy)
            if q in pset and q not in seen:
                seen.add(q)
                stack.append(q)
    return seen == pset


def _shrink(sk: np.ndarray) -> np.ndarray:
    """把骨架收缩到最小像素集:反复删除"度>=3 且删除后不断开"的像素。

    Zhang-Suen 在斜向/环上会留下双像素宽的带(不一定形成 2x2 实心块),
    这些冗余像素度>=3,会被误判成分叉。真分叉的像素删除会断开连接,不受影响。
    """
    sk = sk.copy()
    k3 = np.ones((3, 3), np.float32)
    while True:
        # 注意用 float32:OpenCV 5.x 的 uint8 filter2D 结果有误
        nbc = cv2.filter2D(sk.astype(np.float32), -1, k3, borderType=cv2.BORDER_CONSTANT) - sk
        cand = np.argwhere((sk == 1) & (nbc >= 3))
        removed = False
        for y, x in cand:
            if sk[y, x] and _removable(sk, int(x), int(y)):
                sk[y, x] = 0
                removed = True
        if not removed:
            break
    return sk


def skeletonize(binary: np.ndarray) -> np.ndarray:
    """输入 0/1 uint8,返回 0/1 uint8 骨架。"""
    skel = (binary > 0).astype(np.uint8)
    if not skel.any():
        return skel
    while True:
        changed = False
        for step in (0, 1):
            P = np.pad(skel, 1, mode="constant")
            p2 = P[:-2, 1:-1]
            p3 = P[:-2, 2:]
            p4 = P[1:-1, 2:]
            p5 = P[2:, 2:]
            p6 = P[2:, 1:-1]
            p7 = P[2:, :-2]
            p8 = P[1:-1, :-2]
            p9 = P[:-2, :-2]
            seq = [p2, p3, p4, p5, p6, p7, p8, p9]
            B = sum(seq)
            A = sum(((seq[i] == 0) & (seq[(i + 1) % 8] == 1)) for i in range(8))
            if step == 0:
                cond = (p2 * p4 * p6 == 0) & (p4 * p6 * p8 == 0)
            else:
                cond = (p2 * p4 * p8 == 0) & (p2 * p6 * p8 == 0)
            marker = (skel == 1) & (B >= 2) & (B <= 6) & (A == 1) & cond
            if marker.any():
                skel[marker] = 0
                changed = True
        if not changed:
            break
    return _shrink(skel)
