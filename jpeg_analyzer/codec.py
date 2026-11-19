"""JPEG 编解码:使用 Pillow(libjpeg)真实编码到字节流再解码。

不用压缩参数估算体积 —— 文件字节数直接取编码输出的 len(bytes),
宽高从解码后的实际像素数组读取。
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

# 色度采样方式 -> Pillow subsampling 参数
# 4:4:4 = 全色度(不抽样); 4:2:0 = 水平垂直各减半(四分之一色度)
SUBSAMPLING = {
    "4:4:4 (全色度)": 0,
    "4:2:2 (半色度)": 1,
    "4:2:0 (四分之一色度)": 2,
}

# 文件名里使用的短标记
SUBSAMPLING_TAG = {
    "4:4:4 (全色度)": "444",
    "4:2:2 (半色度)": "422",
    "4:2:0 (四分之一色度)": "420",
}


@dataclass
class CodecResult:
    """一轮真实编码-解码的结果。所有字段来自同一轮,不混用旧数据。"""

    quality: int
    subsampling: str          # SUBSAMPLING 的键
    jpeg_bytes: bytes = field(repr=False, default=b"")
    decoded: np.ndarray = field(repr=False, default=None)  # uint8 RGB (H, W, 3)

    @property
    def nbytes(self) -> int:
        return len(self.jpeg_bytes)

    @property
    def width(self) -> int:
        return int(self.decoded.shape[1])

    @property
    def height(self) -> int:
        return int(self.decoded.shape[0])


def encode_jpeg(rgb: np.ndarray, quality: int, subsampling: str) -> bytes:
    """把 uint8 RGB 数组编码为 JPEG 字节流。"""
    if rgb.dtype != np.uint8 or rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("encode_jpeg 需要 uint8 (H, W, 3) RGB 数组")
    if not 1 <= int(quality) <= 100:
        raise ValueError("quality 须在 1..100")
    if subsampling not in SUBSAMPLING:
        raise ValueError(f"未知色度采样方式: {subsampling}")
    img = Image.fromarray(rgb, "RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=int(quality),
             subsampling=SUBSAMPLING[subsampling])
    return buf.getvalue()


def decode_jpeg(data: bytes) -> np.ndarray:
    """解码 JPEG 字节流为 uint8 RGB 数组。"""
    with Image.open(io.BytesIO(data)) as img:
        rgb = img.convert("RGB")
        return np.array(rgb, dtype=np.uint8)


def run_round(rgb: np.ndarray, quality: int, subsampling: str) -> CodecResult:
    """完整一轮:编码 -> 解码 -> 记录字节数与实际宽高。失败时抛异常由调用方分别处理。"""
    data = encode_jpeg(rgb, quality, subsampling)
    decoded = decode_jpeg(data)
    return CodecResult(quality=int(quality), subsampling=subsampling,
                       jpeg_bytes=data, decoded=decoded)


def load_reference_png(path: str, max_long_edge: int = 1600) -> np.ndarray:
    """读取参考 PNG:必须不透明且长边不超过 max_long_edge。返回 uint8 RGB。"""
    with Image.open(path) as img:
        if img.mode in ("RGBA", "LA", "PA"):
            alpha = np.array(img.getchannel("A"))
            if int(alpha.min()) < 255:
                raise ValueError("参考图必须是不透明 PNG(存在半透明像素)")
        rgb = img.convert("RGB")
        arr = np.array(rgb, dtype=np.uint8)
    h, w = arr.shape[:2]
    if max(w, h) > max_long_edge:
        raise ValueError(f"参考图长边 {max(w, h)} 超过 {max_long_edge} 像素")
    return arr
