"""LZW codec tests: self round-trips, Pillow cross-decoding and corruption."""

from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from giftool import lzw


def _pack(indices: list[int], mcs: int) -> list[bytes]:
    data = lzw.encode(indices, mcs)
    blocks: list[bytes] = []
    p = 1
    while data[p] != 0:
        size = data[p]
        blocks.append(data[p + 1 : p + 1 + size])
        p += 1 + size
    return blocks


@pytest.mark.parametrize("seed", range(10))
@pytest.mark.parametrize("mcs", [2, 4, 8])
def test_roundtrip_small(seed: int, mcs: int) -> None:
    rng = np.random.default_rng(seed)
    limit = 1 << mcs
    indices = rng.integers(0, limit, size=200).tolist()
    assert lzw.decode(_pack(indices, mcs), mcs) == indices


def test_roundtrip_crosses_every_width_boundary() -> None:
    rng = np.random.default_rng(42)
    indices = rng.integers(0, 256, size=3000).tolist()
    assert lzw.decode(_pack(indices, 8), 8) == indices


def test_roundtrip_forces_table_clear() -> None:
    # >4096 learned strings forces mid-stream CLEAR codes.
    rng = np.random.default_rng(7)
    indices = rng.integers(0, 256, size=9000).tolist()
    assert lzw.decode(_pack(indices, 8), 8) == indices


def test_kwkwk_special_case() -> None:
    # The single-code-lookahead special case (code == next_code).
    indices = [0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1]
    assert lzw.decode(_pack(indices, 2), 2) == indices


def _wrap_single_frame_gif(lzw_data: bytes, n: int) -> bytes:
    palette = bytes(range(256)) * 3
    return (
        b"GIF89a"
        + n.to_bytes(2, "little")
        + (1).to_bytes(2, "little")
        + b"\x00\x00\x00"
        + b"\x2c\x00\x00\x00\x00"
        + n.to_bytes(2, "little")
        + (1).to_bytes(2, "little")
        + bytes([0x87])
        + palette[:768]
        + lzw_data
        + b"\x3b"
    )


def test_pillow_decodes_our_stream() -> None:
    rng = np.random.default_rng(99)
    indices = rng.integers(0, 256, size=5000).tolist()
    gif = _wrap_single_frame_gif(lzw.encode(indices, 8), len(indices))
    decoded = list(Image.open(io.BytesIO(gif)).get_flattened_data())
    assert decoded == indices


def test_corruption_raises() -> None:
    with pytest.raises(lzw.LzwError):
        lzw.decode([bytes([255, 255, 255, 255])], 8)


def test_rejects_bad_min_code_size() -> None:
    with pytest.raises(lzw.LzwError):
        lzw.encode([0, 1], 1)
