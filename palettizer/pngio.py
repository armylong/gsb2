"""Real indexed-PNG export and readback.

The exported file is a genuine PNG colour-type-3 image:

* IHDR says ``bit_depth=8, colour_type=3`` (indexed),
* PLTE carries the visible palette (and one extra transparent slot),
* tRNS marks exactly the transparent slot as alpha 0 and every visible
  slot as alpha 255,
* IDAT holds the palette indices, not RGB.

This is written directly with :mod:`zlib` and :mod:`struct` rather than
through Pillow, so palette length and tRNS bytes are exactly what we intend.
The write is verified by re-parsing its own chunks before returning.

Transparent pixels use one dedicated index appended after the visible
colours.  It is not counted against the 4..32 visible-colour budget, and
because tRNS is 255 for every visible entry, no visible colour can be
mistaken for transparent on readback.
"""

from __future__ import annotations

import binascii
import json
import struct
import zlib
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from .quantize import MODE_LABELS, Settings

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class ExportError(RuntimeError):
    pass


def _chunk(ctype: bytes, payload: bytes) -> bytes:
    crc = binascii.crc32(ctype + payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + ctype + payload + struct.pack(">I", crc)


def encode_indexed_png(indices: np.ndarray, palette: np.ndarray, transparent_index: int) -> bytes:
    """Encode (H, W) uint8 indices and (n, 3) uint8 visible palette to PNG bytes."""
    indices = np.asarray(indices, dtype=np.uint8)
    if indices.ndim != 2:
        raise ExportError("indices must be 2-D")
    h, w = indices.shape
    palette = np.asarray(palette, dtype=np.uint8)
    if palette.ndim != 2 or palette.shape[1] != 3:
        raise ExportError("palette must be (n, 3)")
    n = int(palette.shape[0])
    if n > 255:
        raise ExportError("可见颜色过多，无法用 8 位索引表示")
    if transparent_index != n:
        raise ExportError("transparent index must immediately follow the visible palette")

    # PLTE must contain the transparent slot too: index n is the transparent
    # one.  Its RGB is a black placeholder that tRNS overrides to alpha 0.
    # With zero visible colours PLTE is just that one placeholder slot.
    entries = palette.tolist() + [[0, 0, 0]]
    plte = bytes(v for rgb in entries for v in rgb)
    # tRNS covers every entry, 255 for the visible ones and 0 for the slot.
    trns = bytes([255] * n + [0])

    max_index = int(indices.max()) if indices.size else 0
    if max_index > n:
        raise ExportError("index array references a palette entry beyond the transparent slot")

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 3, 0, 0, 0)
    raw = b"".join(b"\x00" + indices[y].tobytes() for y in range(h))
    idat = zlib.compress(raw, 9)

    return b"".join(
        [
            PNG_SIGNATURE,
            _chunk(b"IHDR", ihdr),
            _chunk(b"PLTE", plte),
            _chunk(b"tRNS", trns),
            _chunk(b"IDAT", idat),
            _chunk(b"IEND", b""),
        ]
    )


def _png_chunks(data: bytes) -> list[tuple[bytes, bytes]]:
    if not data.startswith(PNG_SIGNATURE):
        raise ExportError("不是有效的 PNG 文件")
    pos = 8
    chunks: list[tuple[bytes, bytes]] = []
    while pos + 8 <= len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        ctype = data[pos + 4 : pos + 8]
        payload = data[pos + 8 : pos + 8 + length]
        expected = struct.unpack(">I", data[pos + 8 + length : pos + 12 + length])[0]
        actual = binascii.crc32(ctype + payload) & 0xFFFFFFFF
        if expected != actual:
            raise ExportError(f"PNG 块 {ctype!r} CRC 校验失败")
        chunks.append((ctype, payload))
        pos += 12 + length
        if ctype == b"IEND":
            break
    return chunks


@dataclass
class ExportMeta:
    app: str
    version: str
    mode: str
    mode_label: str
    strength: float
    alpha_threshold: int
    transparent_mode: str
    visible_colors: list[list[int]]
    palette_hex: list[str]
    color_format: str
    transparent_index: int
    image_size: tuple[int, int]
    counts: list[int]
    transparent_count: int
    notes: str = ""

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, indent=2)


def export_indexed_png(
    path: str | Path,
    result,
    settings: Settings,
    notes: str = "",
    version: str = "1.0",
) -> ExportMeta:
    """Write a genuine indexed PNG plus a settings JSON sidecar."""
    path = Path(path)
    data = encode_indexed_png(
        result.indices, result.palette_colors, result.transparent_index
    )
    _verify_encoded(data, result)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)

    meta = ExportMeta(
        app="palettizer",
        version=version,
        mode=settings.mode,
        mode_label=MODE_LABELS[settings.mode],
        strength=float(settings.strength),
        alpha_threshold=int(settings.alpha_threshold),
        transparent_mode="binary: alpha >= threshold is opaque, otherwise fully transparent",
        visible_colors=[list(map(int, c)) for c in result.palette_colors.tolist()],
        palette_hex=["#%02X%02X%02X" % tuple(int(v) for v in c) for c in result.palette_colors.tolist()],
        color_format="#RRGGBB",
        transparent_index=int(result.transparent_index),
        image_size=(int(result.indices.shape[1]), int(result.indices.shape[0])),
        counts=[int(v) for v in result.counts.tolist()],
        transparent_count=int(result.transparent_count),
        notes=notes,
    )
    path.with_suffix(".json").write_text(meta.to_json(), encoding="utf-8")
    return meta


def _verify_encoded(data: bytes, result) -> None:
    """Self-check the encoded bytes before writing them to disk."""
    by_kind = dict(_png_chunks(data))
    if b"PLTE" not in by_kind or b"tRNS" not in by_kind or b"IDAT" not in by_kind:
        raise ExportError("导出的 PNG 缺少 PLTE/tRNS/IDAT，未写成索引图")
    bit_depth, color_type = by_kind[b"IHDR"][8], by_kind[b"IHDR"][9]
    if color_type != 3 or bit_depth != 8:
        raise ExportError(f"导出结果不是 8 位索引 PNG（color_type={color_type}, depth={bit_depth}）")
    n = int(result.palette_colors.shape[0])
    expected_trns = bytes([255] * n + [0])
    if by_kind[b"tRNS"] != expected_trns:
        raise ExportError("tRNS 透明度块与调色板不一致")
    expected_plte = (result.palette_colors.tobytes() + b"\x00\x00\x00")
    if by_kind[b"PLTE"] != expected_plte:
        raise ExportError("PLTE 调色板块与当前调色板不一致")


@dataclass
class Readback:
    indices: np.ndarray            # (H, W) uint8, 0..n-1 visible, n = transparent
    palette: np.ndarray            # (n, 3) uint8
    transparent_index: int
    transparent_mask: np.ndarray   # (H, W) bool
    rgba: np.ndarray               # (H, W, 4) uint8, transparent = (0,0,0,0)

    @property
    def visible_color_count(self) -> int:
        return int(self.palette.shape[0])


def read_indexed_png(path: str | Path) -> Readback:
    """Read back an indexed PNG, separating visible colours from transparency.

    Refuses truecolour files, files without tRNS, and tRNS values other than
    0/255 (this tool's transparency model is strictly binary).
    """
    path = Path(path)
    data = path.read_bytes()
    chunks = _png_chunks(data)
    by_kind = dict(chunks)
    if b"IHDR" not in by_kind:
        raise ExportError("回读失败：PNG 缺少 IHDR")
    if b"PLTE" not in by_kind:
        raise ExportError("回读失败：PNG 没有 PLTE 调色板块（可能不是索引图）")
    ihdr = by_kind[b"IHDR"]
    bit_depth, color_type = ihdr[8], ihdr[9]
    if color_type != 3:
        raise ExportError(f"回读失败：不是索引 PNG（color_type={color_type}）")
    if bit_depth != 8:
        raise ExportError(f"回读失败：仅支持 8 位索引 PNG（bit_depth={bit_depth}）")
    if b"tRNS" not in by_kind:
        raise ExportError("回读失败：PNG 没有 tRNS 块，无法确认透明索引")

    plte = by_kind[b"PLTE"]
    if len(plte) % 3 != 0 or not plte:
        raise ExportError("回读失败：PLTE 长度异常")
    n_entries = len(plte) // 3
    palette_all = np.frombuffer(plte, dtype=np.uint8).reshape(n_entries, 3)
    trns = by_kind[b"tRNS"]
    if len(trns) > n_entries:
        raise ExportError("回读失败：tRNS 长度超过调色板项数")
    alphas = np.full((n_entries,), 255, dtype=np.uint8)
    alphas[: len(trns)] = np.frombuffer(trns, dtype=np.uint8)
    bad = (alphas != 0) & (alphas != 255)
    if bad.any():
        raise ExportError("回读失败：tRNS 含有半透明项，本工具只支持完全透明/不透明")
    transparent_entries = np.nonzero(alphas == 0)[0].tolist()
    if len(transparent_entries) != 1:
        raise ExportError(f"回读失败：tRNS 标记了 {len(transparent_entries)} 个全透明索引，预期恰好 1 个")
    trans_idx = int(transparent_entries[0])
    # Per this tool's layout the transparent slot is appended last.  Keep the
    # visible colours in file order, excluding that slot.
    if trans_idx != n_entries - 1:
        raise ExportError("回读失败：透明索引不在末位，不是本工具导出的布局")
    visible = np.ones((n_entries,), dtype=bool)
    visible[trans_idx] = False
    palette = palette_all[visible].copy()

    with Image.open(path) as im:
        if im.mode != "P":
            raise ExportError(f"回读失败：Pillow 读出的模式是 {im.mode}")
        idx = np.array(im, dtype=np.uint8)
    if idx.size and int(idx.max()) >= n_entries:
        raise ExportError("回读失败：像素索引超出调色板范围")

    mask = idx == trans_idx
    remap = np.full((n_entries,), -1, dtype=np.int64)
    remap[visible] = np.arange(int(visible.sum()))
    safe = np.where(mask, 0, idx)
    display_indices = remap[safe].astype(np.uint8)
    display_indices[mask] = len(palette)

    rgba = np.zeros((*idx.shape, 4), dtype=np.uint8)
    if len(palette):
        rgba[~mask, :3] = palette[display_indices[~mask]]
    rgba[~mask, 3] = 255
    return Readback(
        indices=display_indices,
        palette=palette,
        transparent_index=len(palette),
        transparent_mask=mask,
        rgba=rgba,
    )


def readback_matches(result, readback: Readback) -> tuple[bool, str]:
    """Compare an in-memory quantised result with its read-back counterpart."""
    problems: list[str] = []
    if readback.indices.shape != result.indices.shape:
        problems.append(f"尺寸不一致 {readback.indices.shape[::-1]} != {result.indices.shape[::-1]}")
    if not np.array_equal(readback.transparent_mask, result.transparent_mask):
        problems.append("透明掩码不一致")
    if not np.array_equal(readback.palette, result.palette_colors):
        problems.append("可见调色板不一致")
    if readback.transparent_index != result.transparent_index:
        problems.append("透明索引不一致")
    if not problems:
        vis = ~result.transparent_mask
        if not np.array_equal(readback.rgba[vis], _visible_rgba(result)[vis]):
            problems.append("可见像素颜色不一致")
        if not np.array_equal(readback.indices[vis], result.indices[vis]):
            problems.append("可见像素索引不一致")
    if problems:
        return False, "回读校验失败：" + "；".join(problems)
    return True, (
        f"回读校验通过：{readback.indices.shape[1]}x{readback.indices.shape[0]}，"
        f"可见 {readback.visible_color_count} 色，透明索引 #{readback.transparent_index}，"
        f"透明像素 {int(readback.transparent_mask.sum())}"
    )


def _visible_rgba(result) -> np.ndarray:
    h, w = result.indices.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    vis = ~result.transparent_mask
    if result.palette_colors.shape[0]:
        rgba[vis, :3] = result.palette_colors[result.indices[vis]]
    rgba[vis, 3] = 255
    return rgba
