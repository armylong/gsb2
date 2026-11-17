"""Parser + compositor tests against self-generated fixtures and Pillow."""

from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from giftool.compositor import Compositor, render_all, render_frame_at
from giftool.gif_parser import (
    DISPOSAL_BACKGROUND,
    DISPOSAL_KEEP,
    DISPOSAL_PREVIOUS,
    GifParseError,
    parse_gif,
)
from tests.fixtures.fixture_builder import all_fixtures

FIXTURES = all_fixtures()
FIXTURE_BY_NAME = {fx.name: fx for fx in FIXTURES}


@pytest.mark.parametrize("fixture", FIXTURES, ids=[fx.name for fx in FIXTURES])
def test_composite_matches_expected_frames(fixture) -> None:
    doc = parse_gif(fixture.gif_bytes)
    composited = render_all(doc)
    assert len(composited) == len(fixture.expected_frames)
    for actual, expected in zip(composited, fixture.expected_frames):
        assert np.array_equal(actual, expected)


@pytest.mark.parametrize("fixture", FIXTURES, ids=[fx.name for fx in FIXTURES])
def test_metadata_round_trips(fixture) -> None:
    doc = parse_gif(fixture.gif_bytes)
    assert doc.width == fixture.gif_bytes[6] | (fixture.gif_bytes[7] << 8)
    assert doc.loop_count == fixture.loop_count
    assert [f.duration_ms for f in doc.frames] == fixture.durations_ms


def test_stored_tiles_are_partial_not_full_canvas() -> None:
    # local_move stores cropped tiles, proving partial frames stay partial.
    fx = FIXTURE_BY_NAME["local_move"]
    doc = parse_gif(fx.gif_bytes)
    assert all(not (f.width == doc.width and f.height == doc.height) for f in doc.frames)
    # Yet the composited result fills the full canvas.
    for frame in render_all(doc):
        assert frame.shape == (doc.height, doc.width, 4)


def test_transparent_pixels_never_overwrite() -> None:
    fx = FIXTURE_BY_NAME["transparent_bg"]
    doc = parse_gif(fx.gif_bytes)
    compositor = Compositor(doc)
    first = compositor.advance()
    # Snapshot an opaque pixel, then advance: later transparent tiles must not
    # scribble over unrelated canvas cells (disposal resets only its own area).
    assert first[1, 1, 3] == 255
    second = compositor.advance()
    # Frame 1 lives in a different region; frame-0 region is cleared by
    # disposal 2, not overwritten with garbage.
    assert second[1, 1, 3] == 0
    assert second[7, 7, 3] == 255


def test_restore_previous_disposal_three() -> None:
    fx = FIXTURE_BY_NAME["restore_previous"]
    doc = parse_gif(fx.gif_bytes)
    assert doc.frames[1].disposal == DISPOSAL_PREVIOUS
    composited = render_all(doc)
    # Frame 0 and frame 2 must be identical (the overlay was undone).
    assert np.array_equal(composited[0], composited[2])
    # Frame 1 contains the extra green overlay.
    assert composited[1][6, 5, 1] > 0
    assert composited[0][6, 5, 3] == 0


def test_restore_background_disposal_two() -> None:
    fx = FIXTURE_BY_NAME["local_move"]
    doc = parse_gif(fx.gif_bytes)
    assert all(f.disposal == DISPOSAL_BACKGROUND for f in doc.frames)


def test_seek_to_middle_matches_play_from_start() -> None:
    for fixture in FIXTURES:
        doc = parse_gif(fixture.gif_bytes)
        from_start = render_all(doc)
        for index in range(len(doc.frames)):
            assert np.array_equal(render_frame_at(doc, index), from_start[index])


def test_pillow_opens_and_composites_consistently() -> None:
    for fixture in FIXTURES:
        doc = parse_gif(fixture.gif_bytes)
        ours = render_all(doc)
        im = Image.open(io.BytesIO(fixture.gif_bytes))
        for index, our_frame in enumerate(ours):
            im.seek(index)
            pillow_frame = np.asarray(im.convert("RGBA"))
            our_opaque = our_frame[..., 3] != 0
            pillow_opaque = pillow_frame[..., 3] != 0
            assert np.array_equal(our_opaque, pillow_opaque)
            if our_opaque.any():
                assert np.array_equal(
                    our_frame[..., :3][our_opaque],
                    pillow_frame[..., :3][pillow_opaque],
                )


def test_rejects_non_gif() -> None:
    with pytest.raises(GifParseError):
        parse_gif(b"not a gif file at all")


def test_rejects_truncated_gif() -> None:
    fx = FIXTURE_BY_NAME["local_move"]
    with pytest.raises(GifParseError):
        parse_gif(fx.gif_bytes[: len(fx.gif_bytes) // 2])


def test_disposal_constants_present() -> None:
    assert DISPOSAL_KEEP == 1
    assert DISPOSAL_BACKGROUND == 2
    assert DISPOSAL_PREVIOUS == 3


def test_interlaced_frame_is_deinterlaced() -> None:
    from giftool.gif_parser import _deinterlace

    height = width = 8
    grid = np.arange(64, dtype=np.uint8).reshape(height, width)
    rows: list[int] = []
    for start, step in ((0, 8), (4, 8), (2, 4), (1, 2)):
        rows.extend(range(start, height, step))
    interlaced = grid[rows, :]
    assert not np.array_equal(interlaced, grid)
    assert np.array_equal(_deinterlace(interlaced, height, width), grid)


def test_gif_without_netscape_extension_plays_once() -> None:
    # A hand-built GIF89a with no application extension defaults to one play.
    from giftool import lzw

    def u16(value: int) -> bytes:
        return bytes((value & 0xFF, (value >> 8) & 0xFF))

    indices = np.zeros((4, 4), dtype=np.uint8)
    # 2-entry local color table => size field 0, padded to 2 RGB triplets.
    palette = np.array([[0, 0, 0], [255, 0, 0]], dtype=np.uint8)
    lzw_data = lzw.encode(indices.reshape(-1).tolist(), 8)
    image_descriptor = (
        b"\x2c\x00\x00\x00\x00" + u16(4) + u16(4)
        + bytes([0x80])  # local table present, size field 0 -> 2 entries, no interlace
        + palette.tobytes()
    )
    gif = (
        b"GIF89a" + u16(4) + u16(4) + b"\x00\x00\x00"
        + image_descriptor + lzw_data + b"\x3b"
    )
    doc = parse_gif(gif)
    assert doc.loop_count == 1
    assert len(doc.frames) == 1
