"""手动控制点管理与手动/自动对应点的合并估计。

控制点按“无序照片对”存储，每个点包含两张图上的坐标。
控制点不足以求解或点之间明显矛盾时，返回带原因的失败结果，
而不是抛出一个看似成功、实际无位置依据的变换。
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import geometry as geo
from .config import Config


def pair_key(i: int, j: int) -> tuple[int, int]:
    return (i, j) if i < j else (j, i)


@dataclass
class ControlPoint:
    pid: int
    i: int
    j: int
    pt_i: tuple[float, float]
    pt_j: tuple[float, float]


@dataclass
class ManualResult:
    ok: bool
    reasons: list[str]
    H_ji: np.ndarray | None = None
    rmse: float = float("inf")
    points: np.ndarray | None = None  # Nx4: src(i),dst(j)


class ControlPointStore:
    def __init__(self) -> None:
        self._points: dict[tuple[int, int], list[ControlPoint]] = {}
        self._next_id = 1

    # ---- 增 / 改 / 删 ----
    def add(self, i: int, j: int, pt_i, pt_j) -> ControlPoint:
        key = pair_key(i, j)
        a, b = key
        pa = tuple(pt_i) if i == a else tuple(pt_j)
        pb = tuple(pt_j) if j == b else tuple(pt_i)
        cp = ControlPoint(self._next_id, a, b, pa, pb)
        self._next_id += 1
        self._points.setdefault(key, []).append(cp)
        return cp

    def move(self, pid: int, side: str, pt) -> None:
        """side: 'i' 或 'j'，移动该点在对应照片上的坐标。"""
        cp = self._find(pid)
        if side == "i":
            cp.pt_i = (float(pt[0]), float(pt[1]))
        else:
            cp.pt_j = (float(pt[0]), float(pt[1]))

    def remove(self, pid: int) -> None:
        for key, cps in self._points.items():
            before = len(cps)
            self._points[key] = [c for c in cps if c.pid != pid]
            if len(self._points[key]) != before:
                if not self._points[key]:
                    del self._points[key]
                return

    def clear_pair(self, i: int, j: int) -> None:
        self._points.pop(pair_key(i, j), None)

    def _find(self, pid: int) -> ControlPoint:
        for cps in self._points.values():
            for c in cps:
                if c.pid == pid:
                    return c
        raise KeyError(f"控制点 {pid} 不存在")

    def get(self, i: int, j: int) -> list[ControlPoint]:
        return list(self._points.get(pair_key(i, j), []))

    def all_pairs(self) -> list[tuple[int, int]]:
        return sorted(self._points.keys())

    def ordered_arrays(
        self, i: int, j: int
    ) -> tuple[np.ndarray, np.ndarray]:
        """按请求的 (i,j) 方向返回 src(i 坐标) / dst(j 坐标) 数组。"""
        key = pair_key(i, j)
        cps = self._points.get(key, [])
        if not cps:
            return np.empty((0, 2)), np.empty((0, 2))
        if key == (i, j):
            src = np.array([c.pt_i for c in cps], dtype=np.float64)
            dst = np.array([c.pt_j for c in cps], dtype=np.float64)
        else:
            src = np.array([c.pt_j for c in cps], dtype=np.float64)
            dst = np.array([c.pt_i for c in cps], dtype=np.float64)
        return src, dst

    def snapshot(self) -> dict:
        return {
            k: [
                (c.pid, c.i, c.j, c.pt_i, c.pt_j) for c in v
            ]
            for k, v in self._points.items()
        }

    # ---- 仅由控制点估计 ----
    def solve_manual(
        self, i: int, j: int, size_i, size_j, cfg: Config
    ) -> ManualResult:
        src, dst = self.ordered_arrays(i, j)
        n = len(src)
        reasons: list[str] = []
        if n < cfg.min_cp_for_solve:
            reasons.append(
                f"控制点 {n} 个，少于平面单应所需的 "
                f"{cfg.min_cp_for_solve} 个，无法确定位置关系"
            )
            return ManualResult(False, reasons)
        H, mask = geo.homography_from_correspondences(src, dst, cfg, ransac=True)
        if H is None:
            return ManualResult(
                False, ["控制点几何退化（共线/重复），无法求解单应"]
            )
        inl = mask.astype(bool)
        if int(inl.sum()) < cfg.min_cp_for_solve:
            reasons.append(
                f"仅 {int(inl.sum())}/{n} 个控制点彼此一致，"
                "存在明显矛盾的错误控制点"
            )
        H2, _ = geo.homography_from_correspondences(
            src[inl], dst[inl], cfg, ransac=False
        )
        if H2 is not None:
            H = H2
        rmse_all = geo.reprojection_rmse(H, src, dst)
        rmse_in = geo.reprojection_rmse(H, src[inl], dst[inl])
        sanity = geo.check_homography_sanity(H, size_i[1], size_i[0], cfg)
        if not sanity:
            reasons.extend(sanity.reasons)
        if rmse_in > cfg.cp_reproj_warn_px:
            reasons.append(
                f"控制点重投影误差 {rmse_in:.1f}px 偏大，点位可能不够精确"
            )
        points = np.concatenate([src, dst], axis=1)
        ok = not reasons
        return ManualResult(ok, reasons, H, rmse_all, points)
