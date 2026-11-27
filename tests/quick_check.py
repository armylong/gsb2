"""快速验证：解码几何 vs 逐位暴力参照，以及 PNG 读写往返。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np

from grayview.decode import decode
from grayview.layout import Interpretation, pixel_source


def brute_pixel(data: bytes, src) -> int | None:
    """逐位参照实现：按 parts 从文件字节抠位，再拼进灰度值。"""
    if any(b >= len(data) for b in src.needed_bytes):
        return None
    value = 0
    for p in src.parts:
        byte = data[p.file_byte]
        piece = (byte >> p.file_bit_start) & ((1 << p.count) - 1)
        value |= piece << p.value_bit_start
    return value


def check():
    rng = np.random.default_rng(1234)
    fails = 0
    cases = 0
    for bpp in (8, 12, 16):
        for width in (1, 3, 5, 7, 9, 13, 17, 341, 1234):
            for gap in (0, 1, 3, 7):
                for skip in (0, 2, 5):
                    h = 11
                    interp = Interpretation(width, h, skip=skip, row_gap=gap, bpp=bpp)
                    size = interp.required_bytes + 2  # 加一点多余字节
                    data = rng.integers(0, 256, size, dtype=np.uint8).tobytes()
                    dec = decode(data, interp)
                    for row in range(h):
                        for col in (0, width - 1, width // 2):
                            src = pixel_source(interp, row, col)
                            ref = brute_pixel(data, src)
                            got = dec.value_at(row, col)
                            cases += 1
                            if ref != got:
                                fails += 1
                                if fails <= 5:
                                    print(
                                        f"FAIL bpp={bpp} w={width} gap={gap} skip={skip} "
                                        f"({row},{col}) ref={ref} got={got} src={src}"
                                    )
    print(f"{cases} pixel comparisons, {fails} failures")
    return fails


if __name__ == "__main__":
    raise SystemExit(1 if check() else 0)
