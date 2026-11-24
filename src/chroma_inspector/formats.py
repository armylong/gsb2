"""支持的八位平面格式表。

仅收录常见的 8 位平面（planar）与半平面（semi-planar）格式。
高位深、打包格式、硬件派生格式一律拒绝并给出原因，而不是静默转换。
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PixelFormat:
    name: str
    """ffmpeg 像素格式名。"""
    h_sub: int
    """水平色度子采样因子（4:2:0/4:2:2 为 2，4:4:4 为 1）。"""
    v_sub: int
    """垂直色度子采样因子（4:2:0 为 2，4:2:2/4:4:4 为 1）。"""
    layout: str
    """'planar' = Y/U/V 三个独立平面；'semi' = Y 平面 + 交织 UV（或 VU）平面。"""
    swap_uv: bool = False
    """半平面格式中 U/V 顺序是否交换（NV21 为 True）。"""
    full_range: bool = False
    """YUVJ* 旧标记，按全范围（JPEG/JFIF）解释。"""
    bit_depth: int = 8

    @property
    def family(self) -> str:
        if self.h_sub == 1:
            return "4:4:4"
        if self.v_sub == 1:
            return "4:2:2"
        return "4:2:0"

    def chroma_dims(self, width: int, height: int) -> tuple[int, int]:
        cw = (width + self.h_sub - 1) // self.h_sub
        ch = (height + self.v_sub - 1) // self.v_sub
        return cw, ch

    def plane_sizes(self, width: int, height: int) -> tuple[int, int, int]:
        """返回 (Y 字节数, 色度平面字节数, 整帧字节数)。"""
        cw, ch = self.chroma_dims(width, height)
        y_size = width * height
        if self.layout == "planar":
            c_size = cw * ch
            frame_size = y_size + 2 * c_size
        else:  # semi-planar：交织平面为 2*cw*ch
            c_size = 2 * cw * ch
            frame_size = y_size + c_size
        return y_size, c_size, frame_size


_PLANARS = ["yuv420p", "yuvj420p", "yuv422p", "yuvj422p", "yuv444p", "yuvj444p"]
_SEMIS = ["nv12", "nv21"]

PIXEL_FORMATS: dict[str, PixelFormat] = {}
for _name in _PLANARS:
    _j = _name.startswith("yuvj")
    if "420" in _name:
        _h, _v = 2, 2
    elif "422" in _name:
        _h, _v = 2, 1
    else:
        _h, _v = 1, 1
    PIXEL_FORMATS[_name] = PixelFormat(
        name=_name, h_sub=_h, v_sub=_v, layout="planar", full_range=_j
    )
for _name in ("nv12", "nv21"):
    PIXEL_FORMATS[_name] = PixelFormat(
        name=_name, h_sub=2, v_sub=2, layout="semi", swap_uv=(_name == "nv21")
    )

# 常见但明确不支持的格式 -> 原因
REJECTION_REASONS: dict[str, str] = {
    "yuv420p10le": "10 位高位深格式，本工具仅接受八位平面格式",
    "yuv420p12le": "12 位高位深格式，本工具仅接受八位平面格式",
    "yuv422p10le": "10 位高位深格式，本工具仅接受八位平面格式",
    "yuv444p10le": "10 位高位深格式，本工具仅接受八位平面格式",
    "p010le": "10 位高位深半平面格式，本工具仅接受八位平面格式",
    "nv16": "8 位 4:2:2 半平面格式暂未收录，可先用 ffmpeg 转 yuv422p",
    "rgb24": "打包 RGB 格式，没有独立的 Y/Cb/Cr 平面可检查",
    "bgr24": "打包 RGB 格式，没有独立的 Y/Cb/Cr 平面可检查",
    "bgr0": "打包 BGRx 32 位格式，没有独立的 Y/Cb/Cr 平面可检查",
    "0rgb": "打包 RGB 32 位格式，没有独立的 Y/Cb/Cr 平面可检查",
    "argb": "打包 RGB 格式，没有独立的 Y/Cb/Cr 平面可检查",
    "gray": "纯灰度格式，不存在色度平面",
}


def lookup_pixel_format(name: str) -> PixelFormat:
    if name in PIXEL_FORMATS:
        return PIXEL_FORMATS[name]
    reason = REJECTION_REASONS.get(
        name, f"像素格式 {name!r} 不在支持的八位平面格式白名单内"
    )
    from .errors import UnsupportedPixelFormat

    raise UnsupportedPixelFormat(reason)


def split_planes(pf: PixelFormat, frame: bytes, width: int, height: int):
    """把一帧原始字节切成 (Y, U, V) 三个 uint8 二维数组。"""
    import numpy as np

    cw, ch = pf.chroma_dims(width, height)
    y_size, c_size, frame_size = pf.plane_sizes(width, height)
    if len(frame) < frame_size:
        from .errors import MediaError

        raise MediaError(
            f"帧数据不足：需要 {frame_size} 字节，实际 {len(frame)} 字节"
        )
    y = np.frombuffer(frame, dtype=np.uint8, count=y_size).reshape(height, width)
    if pf.layout == "planar":
        u = np.frombuffer(frame, dtype=np.uint8, count=cw * ch, offset=y_size).reshape(
            ch, cw
        )
        v = np.frombuffer(
            frame, dtype=np.uint8, count=cw * ch, offset=y_size + cw * ch
        ).reshape(ch, cw)
        # bytes 支撑的数组只读，显式 copy 交出可写且连续的副本
        return y.copy(), u.copy(), v.copy()
    else:
        interleaved = np.frombuffer(
            frame, dtype=np.uint8, count=2 * cw * ch, offset=y_size
        ).reshape(ch, cw, 2)
        if pf.swap_uv:
            v = np.ascontiguousarray(interleaved[..., 0])
            u = np.ascontiguousarray(interleaved[..., 1])
        else:
            u = np.ascontiguousarray(interleaved[..., 0])
            v = np.ascontiguousarray(interleaved[..., 1])
        return y.copy(), u, v
