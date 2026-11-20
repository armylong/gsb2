"""双色印刷叠印模型。

模型：双墨 Neugebauer 模型，叠印区用 Demichel 概率混合。

给定纸色 W、墨 A 实底 S_a、墨 B 实底 S_b（均为线性 RGB，0..1），
两版覆盖率（墨量）a, b ∈ [0, 1]，Demichel 给出四种成色单元的面积比例：

    p_空纸   = (1-a)(1-b)
    p_仅A    = a(1-b)
    p_仅B    = (1-a)b
    p_叠印AB = a·b

预测反射率（线性 RGB，对面积取均值 —— 即密度混合）：

    R = p_空纸·W + p_仅A·S_a + p_仅B·S_b + p_叠印·S_ab

其中 S_ab 为叠印实底色。默认用"透明墨串联"假设计算：
墨层 t_x = S_x / W（逐通道透射率），则 S_ab = W·t_a·t_b = S_a·S_b/W，
通道结果超出 [0,1] 时截断并给出告警；也可以直接由用户指定叠印色。

该模型可说明、可复算，是分色与重合成共同使用的唯一正向模型。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import color as C


@dataclass
class InkParams:
    """一组完整的双色印刷参数（线性 RGB）。"""

    paper_rgb: np.ndarray
    solid_a_rgb: np.ndarray
    solid_b_rgb: np.ndarray
    overprint_rgb: np.ndarray
    clamp_warned: bool = False

    @classmethod
    def from_hex(cls, paper_hex: str, ink_a_hex: str, ink_b_hex: str,
                 overprint_hex: str | None = None) -> "InkParams":
        paper = C.hex_to_rgb(paper_hex)
        sa = C.hex_to_rgb(ink_a_hex)
        sb = C.hex_to_rgb(ink_b_hex)
        warned = False
        if overprint_hex is None:
            # 透明墨串联假设
            op = sa * sb / np.maximum(paper, 1e-9)
            if np.any(op > 1.0 + 1e-9) or np.any(op < -1e-9):
                warned = True
            op = np.clip(op, 0.0, 1.0)
        else:
            op = C.hex_to_rgb(overprint_hex)
        return cls(paper, sa, sb, op, warned)

    def to_dict(self) -> dict:
        return {
            "paper_hex": C.rgb_to_hex(self.paper_rgb),
            "ink_a_hex": C.rgb_to_hex(self.solid_a_rgb),
            "ink_b_hex": C.rgb_to_hex(self.solid_b_rgb),
            "overprint_hex": C.rgb_to_hex(self.overprint_rgb),
            "overprint_model": "transparent-ink series (W·ta·tb), clipped",
            "clamp_warning": self.clamp_warned,
        }


def composite(a: np.ndarray, b: np.ndarray, p: InkParams) -> np.ndarray:
    """正向重合成。a,b 为覆盖率数组（任意同形状，0..1），输出线性 RGB (...,3)。"""
    a = np.clip(np.asarray(a, dtype=np.float64), 0.0, 1.0)
    b = np.clip(np.asarray(b, dtype=np.float64), 0.0, 1.0)
    pa = a[..., None]
    pb = b[..., None]
    return (
        (1.0 - pa) * (1.0 - pb) * p.paper_rgb
        + pa * (1.0 - pb) * p.solid_a_rgb
        + (1.0 - pa) * pb * p.solid_b_rgb
        + pa * pb * p.overprint_rgb
    )


def ink_usage(a: np.ndarray, b: np.ndarray, pixel_area: float = 1.0) -> dict:
    """估算两版各自的总墨量（覆盖率之和 × 单像素面积）与均值。

    覆盖率 1.0 表示该像素被实底墨完全覆盖；单位由 pixel_area 决定
    （例如印刷分辨率下像素面积 mm²，结果就是 mm² 的等效满覆面积）。
    """
    a = np.clip(np.asarray(a, dtype=np.float64), 0.0, 1.0)
    b = np.clip(np.asarray(b, dtype=np.float64), 0.0, 1.0)
    n = a.size
    return {
        "pixels": int(n),
        "pixel_area": float(pixel_area),
        "plate_a_mean_coverage": float(a.mean()),
        "plate_b_mean_coverage": float(b.mean()),
        "plate_a_ink_units": float(a.sum() * pixel_area),
        "plate_b_ink_units": float(b.sum() * pixel_area),
        "total_ink_units": float((a.sum() + b.sum()) * pixel_area),
        "mean_total_area_coverage": float((a + b).mean()),
        "max_total_area_coverage": float((a + b).max()),
    }


def build_gamut_grid(p: InkParams, n: int = 65) -> tuple[np.ndarray, np.ndarray]:
    """构造覆盖率网格上的色域样本。

    返回:
      grid_ab  : (n*n, 2) 覆盖率 (a, b)
      grid_rgb : (n*n, 3) 对应线性 RGB
    """
    t = np.linspace(0.0, 1.0, n)
    aa, bb = np.meshgrid(t, t, indexing="ij")
    ab = np.stack([aa.ravel(), bb.ravel()], axis=1)
    rgb = composite(ab[:, 0], ab[:, 1], p)
    return ab, rgb
