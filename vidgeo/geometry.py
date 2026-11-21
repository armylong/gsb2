"""几何模型：编码尺寸、像素宽高比(PAR)、显示方向之间的全部换算。

术语约定
--------
- 编码/存储尺寸 coded (cw, ch)：文件里实际存的像素矩阵大小。
- PAR (pixel/sample aspect ratio)：单个像素的 宽:高。PAR=1:1 即方形像素。
- DAR (display aspect ratio)：显示宽高比，DAR = (cw/ch) * PAR。
- rotation：显示方向元数据（逆时针度数，ffmpeg/ffprobe 约定），
  播放器在显示时把存储画面旋转这个角度后再给用户看。
- 标记点一律用 *归一化显示坐标* (u, v)，均以“播放器最终显示画面”为基准、
  左上角为 (0,0)、右下角为 (1,1)。它在转换前后不变——这就是
  “转换前后标记点位置与比例一致”的数学表达。
"""
from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
import math
from typing import Dict, Optional, Tuple

SUPPORTED_ROTATIONS = (0, 90, 180, 270)


class UnsupportedOrientationError(ValueError):
    """方向信息不在支持范围内（非 90 度整数倍，或含镜像翻转）。"""


@dataclass
class VideoGeometry:
    coded_width: int
    coded_height: int
    par_num: int
    par_den: int
    rotation: int                      # 归一化到 [0, 360) 的逆时针度数
    mirrored: bool = False
    unsupported_detail: Optional[str] = None   # 不支持方向时的明确说明

    # ------------------------------------------------------------------ #
    # 基础量
    # ------------------------------------------------------------------ #
    @property
    def par(self) -> Fraction:
        return Fraction(self.par_num, self.par_den)

    @property
    def is_square_pixel(self) -> bool:
        return self.par_num == self.par_den

    @property
    def is_supported(self) -> bool:
        return (
            not self.mirrored
            and self.unsupported_detail is None
            and self.rotation in SUPPORTED_ROTATIONS
        )

    @property
    def is_rotated(self) -> bool:
        """显示画面相对存储画面是否交换了宽高（90/270 度）。"""
        return self.rotation in (90, 270)

    @property
    def coded_dar(self) -> Fraction:
        """只按原始像素（忽略方向）显示时的宽高比。"""
        return Fraction(self.coded_width, self.coded_height) * self.par

    @property
    def display_dar(self) -> Fraction:
        """播放器方式显示（PAR + 方向都生效）的宽高比。"""
        if self.is_rotated:
            return Fraction(self.coded_height, self.coded_width) / self.par
        return self.coded_dar

    @property
    def raw_display_size(self) -> Tuple[int, int]:
        """按原始像素直接铺开的显示尺寸（含 PAR 形变，不应用方向）。"""
        return self.coded_width, self.coded_height

    @property
    def display_size(self) -> Tuple[int, int]:
        """播放器方式显示的逻辑尺寸（整数，PAR 与方向均已体现）。"""
        if self.is_rotated:
            # 存储高 -> 显示宽；存储宽 * PAR -> 显示高
            return (
                self.coded_height,
                round(self.coded_width * self.par),
            )
        return (
            round(self.coded_width * self.par),
            self.coded_height,
        )

    # ------------------------------------------------------------------ #
    # 成片尺寸：把 PAR 与方向全部烘焙到像素里、PAR 强制为 1:1
    # ------------------------------------------------------------------ #
    def ideal_output_size(self) -> Tuple[Fraction, Fraction]:
        """不取整时的理论成片尺寸（分数，精确）。"""
        if self.is_rotated:
            return (
                Fraction(self.coded_height),
                Fraction(self.coded_width) * self.par,
            )
        return (
            Fraction(self.coded_width) * self.par,
            Fraction(self.coded_height),
        )

    def output_size(self, even_policy: str = "nearest") -> Tuple[int, int]:
        """取整后的成片尺寸。

        even_policy:
            "nearest" —— 四舍五入到最近偶数（默认，形变更小）；
            "down"    —— 向下取偶（只裁不补）。
        宽高都取偶数是 H.264 yuv420p 的硬性要求。
        """
        iw, ih = self.ideal_output_size()
        return (_to_even(iw, even_policy), _to_even(ih, even_policy))

    def edge_deltas(self, even_policy: str = "nearest") -> Dict[str, Fraction]:
        """取整造成的各边缘变化（成片像素单位，正=补、负=裁）。

        输出 {"left","right","top","bottom"}，按“误差对称分摊”的方式
        描述成片相对理想画面的边缘变化，方便在界面上展示。
        """
        iw, ih = self.ideal_output_size()
        ow, oh = self.output_size(even_policy)
        dx = Fraction(ow) - iw
        dy = Fraction(oh) - ih
        return {
            "left": dx / 2,
            "right": dx / 2,
            "top": dy / 2,
            "bottom": dy / 2,
        }

    # ------------------------------------------------------------------ #
    # ffmpeg 滤镜链
    # ------------------------------------------------------------------ #
    def bake_filter_chain(
        self, out_w: int, out_h: int, flags: str = "lanczos"
    ) -> str:
        """生成把 PAR 和方向都落实到像素上的 -vf 滤镜链。

        前置条件：调用 ffmpeg 时输入侧必须带
        ``-noautorotate -display_rotation 0``，
        否则旋转元数据会残留，播放器会再转一次。
        """
        par = self.par
        if self.rotation in (0, 180):
            baked_w, baked_h = out_w, out_h
        else:
            # 先在存储坐标系里按 PAR 拉伸（宽随 PAR 变），转置后即得目标
            baked_w, baked_h = out_h, out_w
        chain = [
            f"scale={baked_w}:{baked_h}:flags={flags}",
            "setsar=1",
        ]
        if self.rotation == 90:
            chain.append("transpose=2")   # 逆时针 90
        elif self.rotation == 180:
            chain.append("hflip,vflip")
        elif self.rotation == 270:
            chain.append("transpose=1")   # 顺时针 90
        # 转置/翻转后若取整尺寸与目标有偏差，再做一次整数尺寸对齐
        chain.append(f"scale={out_w}:{out_h}:flags={flags}")
        chain.append("setsar=1")
        return ",".join(chain)

    # ------------------------------------------------------------------ #
    # 坐标换算：标记点在三个坐标系之间的映射
    # ------------------------------------------------------------------ #
    def display_to_output(
        self, u: float, v: float, even_policy: str = "nearest"
    ) -> Tuple[float, float]:
        """播放器显示归一化坐标 -> 成片像素坐标（浮点）。"""
        ow, oh = self.output_size(even_policy)
        return u * ow, v * oh

    def display_to_coded(self, u: float, v: float) -> Tuple[float, float]:
        """播放器显示归一化坐标 -> 存储像素矩阵中的浮点坐标。

        用于“在预览里点一处，指出它在原始编码画面中的对应位置”。
        """
        cw, ch = float(self.coded_width), float(self.coded_height)
        r = self.rotation
        if r == 0:
            x, y = u * cw, v * ch
        elif r == 90:
            # 显示 (u,v) <- 存储 (x,y): u=1-y/ch, v=x/cw
            x, y = v * cw, (1 - u) * ch
        elif r == 180:
            x, y = (1 - u) * cw, (1 - v) * ch
        else:  # 270
            # u=y/ch, v=1-x/cw
            x, y = (1 - v) * cw, u * ch
        return x, y

    def coded_to_display(self, x: float, y: float) -> Tuple[float, float]:
        """存储像素坐标 -> 播放器显示归一化坐标（display_to_coded 的逆）。"""
        cw, ch = float(self.coded_width), float(self.coded_height)
        u_c, v_c = x / cw, y / ch
        r = self.rotation
        if r == 0:
            return u_c, v_c
        if r == 90:
            return 1 - v_c, u_c
        if r == 180:
            return 1 - u_c, 1 - v_c
        return v_c, 1 - u_c

    def corner_markers(self, even_policy: str = "nearest") -> list:
        """四角编号标记在三个坐标系下的完整位置表。

        编号固定按 *播放器显示画面* 的四角：1=左上 2=右上 3=左下 4=右下。
        每条记录含归一化坐标、成片像素坐标、存储像素坐标。
        """
        corners = [
            (1, 0.0, 0.0),
            (2, 1.0, 0.0),
            (3, 0.0, 1.0),
            (4, 1.0, 1.0),
        ]
        rows = []
        for num, u, v in corners:
            ox, oy = self.display_to_output(u, v, even_policy)
            cx, cy = self.display_to_coded(u, v)
            rows.append(
                {
                    "marker": num,
                    "u": u,
                    "v": v,
                    "output_xy": (round(ox, 2), round(oy, 2)),
                    "coded_xy": (round(cx, 2), round(cy, 2)),
                }
            )
        return rows


def _to_even(value: Fraction, policy: str) -> int:
    if policy == "down":
        n = math.floor(value)     # 向下取整
        if n % 2:
            n -= 1
        return max(2, n)
    # nearest：先四舍五入到整数，再在两个偶数邻居里选更近的；
    # 距离相同时取较大的偶数（可预期的确定性规则）
    n = math.floor(value + Fraction(1, 2))
    if n % 2 == 0:
        return max(2, n)
    lower, upper = n - 1, n + 1
    if abs(value - lower) <= abs(value - upper):
        return max(2, lower)
    return upper


def normalize_rotation(degrees: float) -> int:
    """把任意角度归一化到 [0,360)；非 90 度整数倍抛 UnsupportedOrientationError。"""
    r = degrees % 360
    if r not in SUPPORTED_ROTATIONS:
        raise UnsupportedOrientationError(
            f"不支持的显示方向：{degrees:g}°（归一化后 {r:g}°）。"
            "本工具只处理 0/90/180/270 度的直角旋转，"
            "该文件需要先在专业软件中手动校正。"
        )
    return r
