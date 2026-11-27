"""自带样本生成。

两类可生成的样本：

1. ``row_shift`` 错行样本
   文件按“行步长比真实每行字节数小 shift 字节”的旧程序逻辑写出来，像素值本身
   是随行号线性变化的斜坡。只要用正确参数读取，第一行位置对，之后每行都会
   逐行向上错位 shift 字节——所有行的像素内容不重叠，能直接看出偏移从第几行开始。

2. ``cross_byte`` 12 位跨字节样本
   奇数宽 + 每行从最低位连续打包，某些像素一定跨两个或三个字节。样本附带
   ``expect`` 清单，列出若干“代表性像素”的灰度值和取字节/取位范围，供人眼和
   脚本核对。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .encode import pack_rows
from .layout import Interpretation, pixel_source

GAP_FILL = 0x5A
SKIP_FILL = 0xA5


@dataclass
class Sample:
    name: str
    path: Path
    interp: Interpretation           # 用这份参数读，才看得到预期的错位
    file_bytes: int
    note: str
    probe: dict | None = None       # 指定像素的读数预期（json 可序列化）
    extra: dict | None = None


def _probe(interp: Interpretation, vals: np.ndarray, points: list[tuple[int, int]]) -> list[dict]:
    out = []
    for row, col in points:
        src = pixel_source(interp, row, col)
        out.append(
            {
                "row": row,
                "col": col,
                "value": int(vals[row, col]),
                "value_hex": f"0x{int(vals[row, col]):04X}",
                "file_bytes": list(src.needed_bytes),
                "bits": [
                    {
                        "byte": p.file_byte,
                        "bit_start": p.file_bit_start,
                        "bit_end": p.file_bit_end,
                        "value_bit_start": p.value_bit_start,
                        "value_bit_end": p.value_bit_end,
                    }
                    for p in src.parts
                ],
            }
        )
    return out


def make_row_shift(
    out_dir: Path,
    *,
    width: int = 7,
    height: int = 10,
    shift: int = 2,
    bpp: int = 8,
) -> Sample:
    """错行样本：真实行步长故意比解释参数大 shift 字节。

    生成时按 ``writer_interp = Interpretation(w, h, row_gap=gap+shift, ...)``
    写入，读的时候用 ``reader_interp = Interpretation(w, h, row_gap=gap, ...)``。
    """
    if shift <= 0:
        raise ValueError("shift 必须为正，才能造成错位")
    gap = 1
    reader = Interpretation(width, height, skip=4, row_gap=gap, bpp=bpp)
    writer = Interpretation(width, height, skip=4, row_gap=gap + shift, bpp=bpp)
    maxv = (1 << bpp) - 1
    # 每个像素 = 行号*step + 列号，读对了行号就是明显的横向色带
    vals = np.zeros((height, width), dtype=np.uint16)
    for r in range(height):
        for c in range(width):
            base = (r % 8) * 32 + c * 3
            vals[r, c] = min(base, maxv)
    data = pack_rows(vals, writer)
    path = out_dir / f"row_shift_{bpp}bit_{width}x{height}_s{shift}.bin"
    path.write_bytes(data)
    probe = _probe(
        writer,
        vals,
        [(0, 0), (0, width - 1), (1, 0), (1, width - 1), (height - 1, 0)],
    )
    return Sample(
        name="row_shift",
        path=path,
        interp=reader,
        file_bytes=len(data),
        note=(
            f"生成时每行实际步长比读参多 {shift} B（写参 gap={gap + shift}，"
            f"读参 gap={gap}）。用读参看图：第 0 行对，第 r 行起头读到了"
            f"真实第 r 行内偏移 +{shift} B 的位置，越往下越偏。"
        ),
        probe={
            "reader_params": reader.as_dict(),
            "writer_params": writer.as_dict(),
            "shift_bytes": shift,
            "pixels": probe,
        },
        extra={"writer_params": writer.as_dict()},
    )


def make_cross_byte(
    out_dir: Path,
    *,
    width: int = 9,
    height: int = 6,
    skip: int = 3,
    gap: int = 2,
    seed: int = 2026,
) -> Sample:
    """12 位、奇数宽、带前置跳过和行间空白的跨字节样本。"""
    interp = Interpretation(width, height, skip=skip, row_gap=gap, bpp=12)
    rng = np.random.default_rng(seed)
    vals = rng.integers(0, 4096, size=(height, width), dtype=np.uint16)
    data = pack_rows(
        vals, interp, skip_fill=SKIP_FILL, gap_fill=GAP_FILL, trailing_gap=gap > 0
    )
    path = out_dir / f"cross_byte_12bit_{width}x{height}.bin"
    path.write_bytes(data)
    points = [(0, 0), (0, 1), (0, 2), (0, width - 1), (1, 1), (height - 1, width - 2)]
    return Sample(
        name="cross_byte",
        path=path,
        interp=interp,
        file_bytes=len(data),
        note=(
            f"12 位每行从最低位连续打包，宽 {width} 为奇数，因此每 2 个像素就有一个"
            "跨字节；skip 区(0xA5)与行间空白(0x5A)都填了特征字节便于识别。"
        ),
        probe={
            "reader_params": interp.as_dict(),
            "pixels": _probe(interp, vals, points),
        },
    )


def make_short_file(out_dir: Path, *, width: int = 5, height: int = 4, bpp: int = 8) -> Sample:
    """截断样本：只写到第 2 行中间，用于核对缺失标注。"""
    interp = Interpretation(width, height, skip=2, row_gap=1, bpp=bpp)
    maxv = (1 << bpp) - 1
    vals = np.array(
        [[(r * 40 + c * 5) % (maxv + 1) for c in range(width)] for r in range(height)],
        dtype=np.uint16,
    )
    full = pack_rows(vals, interp)
    cut = interp.row_start(2) + 3  # 第 2 行只有 3 字节
    data = full[:cut]
    path = out_dir / f"short_{bpp}bit_{width}x{height}.bin"
    path.write_bytes(data)
    return Sample(
        name="short_file",
        path=path,
        interp=interp,
        file_bytes=len(data),
        note=f"文件在第 2 行中截断（应有 {interp.required_bytes} B，实际 {len(data)} B）。",
        probe={"pixels": _probe(interp, vals, [(1, width - 1)])},
    )


def write_all(out_dir: Path, *, seed: int = 2026) -> list[Sample]:
    out_dir.mkdir(parents=True, exist_ok=True)
    samples = [
        make_cross_byte(out_dir, seed=seed),
        make_row_shift(out_dir),
        make_short_file(out_dir),
    ]
    manifest = {
        "samples": [
            {
                "name": s.name,
                "file": s.path.name,
                "bytes": s.file_bytes,
                "params": s.interp.as_dict(),
                "note": s.note,
                "probe": s.probe,
            }
            for s in samples
        ]
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return samples
