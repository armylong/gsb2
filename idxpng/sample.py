"""自带样本: 奇数宽、几组故意同色但编号不同、一个半透明色号。

图案用 ASCII 网格声明, 字符 -> 色号, 方便验证脚本直接推导每个色号的位置。
"""

from __future__ import annotations

from pathlib import Path

from .model import IndexedImage, RGBA
from .png_io import write_indexed_png

# 仓库根/samples(本文件位于 <root>/idxpng/sample.py)
SAMPLE_DIR = Path(__file__).resolve().parent.parent / "samples"
SAMPLE_PATH = SAMPLE_DIR / "sample_odd11_duplicate_alpha_4bit.png"

# 0 全透明; 1 墨色描边
# 2 与 3 是完全相同的红(故意同色异号), 分别画左右两块
# 4 与 5 是完全相同的蓝(同上)
# 6 金色(只用 1 像素)
# 7 半透明薄荷绿(alpha=128)
SAMPLE_PALETTE: list[RGBA] = [
    (0, 0, 0, 0),
    (43, 45, 66, 255),
    (239, 83, 80, 255),
    (239, 83, 80, 255),
    (66, 165, 245, 255),
    (66, 165, 245, 255),
    (255, 202, 40, 255),
    (102, 187, 106, 128),
]

# 宽 11(奇数), 高 11
SAMPLE_ROWS = [
    "...........",
    ".1111.1111.",
    ".1221.1331.",
    ".1221.1331.",
    ".1111.1111.",
    ".777767777.",
    ".1111.1111.",
    ".1441.1551.",
    ".1441.1551.",
    ".1111.1111.",
    "...........",
]

CHAR_TO_INDEX = {".": 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7}


def build_sample() -> IndexedImage:
    width = len(SAMPLE_ROWS[0])
    height = len(SAMPLE_ROWS)
    assert width % 2 == 1, "样本宽度必须是奇数"
    for row in SAMPLE_ROWS:
        assert len(row) == width, "样本每行必须等宽"

    indices = bytearray(width * height)
    for y, row in enumerate(SAMPLE_ROWS):
        for x, ch in enumerate(row):
            indices[y * width + x] = CHAR_TO_INDEX[ch]

    return IndexedImage(
        width=width,
        height=height,
        indices=indices,
        palette=[tuple(c) for c in SAMPLE_PALETTE],  # type: ignore[arg-type]
        bit_depth=4,  # 8 个槽位、色号 0..7, 用真 4 位打包
        title=SAMPLE_PATH.name,
    )


def ensure_sample_file() -> Path:
    """生成(或覆盖为标准内容)样本 PNG, 返回路径。"""
    doc = build_sample()
    path, depth, _ = write_indexed_png(doc, SAMPLE_PATH, bit_depth="4")
    assert depth == 4
    return path


if __name__ == "__main__":
    p = ensure_sample_file()
    print(f"sample written: {p}")
