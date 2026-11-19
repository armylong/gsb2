"""剖面与色度误差测量。

关键约定:
- 所有比较都在 *重建到与 4:4:4 相同的全尺寸* 之后进行 (最近邻上采样)。
- 误差只在用户指定的测量区域内统计 Cb / Cr 平面; 不用整幅 RGB 平均误差
  代表全部色边现象 (整幅均值会把细线上的局部失真稀释掉)。
- 亮度 Y 三路共享同一份数据, 同时给出数值核对。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .color import MODES, upsample
from .pipeline import Project


@dataclass
class RegionStats:
    mode: str
    x0: int
    y0: int
    x1: int
    y1: int
    pixels: int
    y_identical: bool
    cb_mae: float
    cb_max: int
    cr_mae: float
    cr_max: int
    cb_changed_pct: float
    cr_changed_pct: float

    def as_lines(self) -> list[str]:
        label = {"444": "4:4:4", "422": "4:2:2", "420": "4:2:0"}.get(self.mode, self.mode)
        return [
            f"模式 {label}  区域 x[{self.x0},{self.x1}) y[{self.y0},{self.y1})  共 {self.pixels} px",
            f"Y 与 4:4:4 完全一致: {'是' if self.y_identical else '否'}",
            f"Cb MAE={self.cb_mae:.3f}  最大={self.cb_max}  变化像素={self.cb_changed_pct:.1f}%",
            f"Cr MAE={self.cr_mae:.3f}  最大={self.cr_max}  变化像素={self.cr_changed_pct:.1f}%",
        ]


def reconstructed_planes(project: Project, index: int, mode: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """返回全尺寸 (H,W) 的 Y / Cb / Cr; 色度已最近邻重建, 可直接与 4:4:4 逐像素比较。"""
    y, cb_sub, cr_sub = project.get_planes(index, mode)
    h, w = y.shape
    cb = upsample(cb_sub, mode, h, w)
    cr = upsample(cr_sub, mode, h, w)
    return y, cb, cr


def measure_region(project: Project, index: int, mode: str,
                   x0: int, y0: int, x1: int, y1: int) -> RegionStats:
    x0 = max(0, int(x0))
    y0 = max(0, int(y0))
    x1 = min(project.width, int(x1))
    y1 = min(project.height, int(y1))
    if x1 <= x0 or y1 <= y0:
        raise ValueError("测量区域为空")

    y_ref, cb_ref, cr_ref = reconstructed_planes(project, index, "444")
    y, cb, cr = reconstructed_planes(project, index, mode)

    def _stats(a: np.ndarray, b: np.ndarray) -> tuple[float, int, float]:
        d = np.abs(a.astype(np.int16) - b.astype(np.int16))
        mae = float(d.mean())
        mx = int(d.max())
        changed = float((d > 0).mean() * 100.0)
        return mae, mx, changed

    cb_mae, cb_max, cb_pct = _stats(cb[y0:y1, x0:x1], cb_ref[y0:y1, x0:x1])
    cr_mae, cr_max, cr_pct = _stats(cr[y0:y1, x0:x1], cr_ref[y0:y1, x0:x1])

    return RegionStats(
        mode=mode,
        x0=x0, y0=y0, x1=x1, y1=y1,
        pixels=(x1 - x0) * (y1 - y0),
        y_identical=bool(np.array_equal(y, y_ref)),
        cb_mae=cb_mae, cb_max=cb_max, cb_changed_pct=cb_pct,
        cr_mae=cr_mae, cr_max=cr_max, cr_changed_pct=cr_pct,
    )


def measure_all_modes(project: Project, index: int,
                      x0: int, y0: int, x1: int, y1: int) -> list[RegionStats]:
    out = []
    for mode in MODES:
        out.append(measure_region(project, index, mode, x0, y0, x1, y1))
    return out


@dataclass
class Profile:
    orientation: str          # "h" 沿 x 方向 (固定 y); "v" 沿 y 方向 (固定 x)
    position: int             # 固定的行/列号
    axis: np.ndarray          # 坐标 (像素编号)
    data: dict[str, dict[str, np.ndarray]]  # mode -> {Y, Cb, Cr, Cb_err, Cr_err}


def extract_profile(project: Project, index: int,
                    orientation: str, position: int) -> Profile:
    if orientation not in ("h", "v"):
        raise ValueError("orientation 必须是 h 或 v")
    h, w = project.height, project.width
    position = int(position)
    if orientation == "h" and not 0 <= position < h:
        raise ValueError(f"行号超出 0..{h - 1}")
    if orientation == "v" and not 0 <= position < w:
        raise ValueError(f"列号超出 0..{w - 1}")

    _, cb_ref, cr_ref = reconstructed_planes(project, index, "444")
    data: dict[str, dict[str, np.ndarray]] = {}
    for mode in MODES:
        y, cb, cr = reconstructed_planes(project, index, mode)
        if orientation == "h":
            yv, cbv, crv = y[position, :], cb[position, :], cr[position, :]
            cb_ref_v, cr_ref_v = cb_ref[position, :], cr_ref[position, :]
            axis = np.arange(w)
        else:
            yv, cbv, crv = y[:, position], cb[:, position], cr[:, position]
            cb_ref_v, cr_ref_v = cb_ref[:, position], cr_ref[:, position]
            axis = np.arange(h)
        data[mode] = {
            "Y": yv.astype(np.int16),
            "Cb": cbv.astype(np.int16),
            "Cr": crv.astype(np.int16),
            "Cb_err": np.abs(cbv.astype(np.int16) - cb_ref_v.astype(np.int16)),
            "Cr_err": np.abs(crv.astype(np.int16) - cr_ref_v.astype(np.int16)),
        }
    return Profile(orientation=orientation, position=position, axis=axis, data=data)
