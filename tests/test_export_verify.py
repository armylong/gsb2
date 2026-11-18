"""Export and read-back verification tests.

The verification path never calls the editor compositor: it decodes the file
with the small independent reader in ``apng_editor.apng_codec``.  Expected
pixels come from hand-written formulas and from the samples' documented
constants.
"""

from __future__ import annotations

import struct

import numpy as np
import pytest
from apng import parse_chunks
from PIL import Image

from apng_editor.apng_codec import (
    APNGReadError,
    decode_apng,
    _over,
    _unfilter,
)
from apng_editor.exporter import (
    DURATION_TOLERANCE_MS,
    export_apng,
    verify_export,
)
from apng_editor.model import Frame, Project, compose_project
from apng_editor.samples import (
    GREEN,
    RED,
    SEMI_BLUE,
    SEMI_WHITE,
    SEMI_YELLOW,
    expected_alpha_overlap_inside,
    expected_alpha_overlap_outside,
    expected_blend_over,
    expected_move_clear_overlap,
    expected_restore_overlap,
    sample_alpha_overlap,
    sample_move_and_clear,
    sample_restore_previous,
    solid_tile,
)


def pixel(array: np.ndarray, x: int, y: int) -> tuple[int, int, int, int]:
    return tuple(int(v) for v in array[y, x])


def chunk_types(data: bytes) -> list[str]:
    return [chunk.type for chunk in parse_chunks(data)]


# ------------------------------------------------------------ file shape
def test_export_has_apng_structure_and_rgba_ihdr(tmp_path) -> None:
    project = sample_alpha_overlap()
    path = export_apng(project, tmp_path / "sample.png")
    assert path.exists()
    raw = path.read_bytes()
    assert raw.startswith(b"\x89PNG\r\n\x1a\n")
    types = chunk_types(raw)
    assert types[0] == "IHDR"
    assert "acTL" in types
    assert "fcTL" in types
    assert "fdAT" in types

    ihdr_len = struct.unpack(">I", raw[8:12])[0]
    assert ihdr_len == 13
    assert raw[12:16] == b"IHDR"
    # IHDR payload directly follows length+type at byte 16.
    assert raw[24] == 8  # bit depth
    assert raw[25] == 6  # colour type RGBA
    assert raw[26] == 0  # deflate
    assert raw[27] == 0  # adaptive filtering
    assert raw[28] == 0  # no interlacing


def test_no_ui_helpers_in_exported_pixels(tmp_path) -> None:
    # The checkerboard used by the UI is 204/153 grey; the exported file must
    # contain no such pixel because the we only ever write the composite.
    project = sample_alpha_overlap()
    path = export_apng(project, tmp_path / "clean.png")
    decoded = decode_apng(path)
    for frame in decoded.frames:
        colours = {tuple(int(v) for v in px) for px in frame.pixels.reshape(-1, 4)}
        assert (204, 204, 204, 255) not in colours
        assert (153, 153, 153, 255) not in colours


def test_roundtrip_matches_compositor_for_all_samples(tmp_path) -> None:
    for factory in (sample_alpha_overlap, sample_move_and_clear, sample_restore_previous):
        project = factory()
        path = export_apng(project, tmp_path / f"{factory.__name__}.png")
        decoded = decode_apng(path)
        expected = compose_project(project)
        assert decoded.declared_frames == len(expected)
        assert (decoded.width, decoded.height) == project.canvas_size
        assert decoded.loop_count == project.loop_count
        for index, frame in enumerate(decoded.frames):
            assert np.array_equal(frame.pixels, expected[index]), index
            assert frame.duration_ms == project.frames[index].duration_ms


def test_durations_and_loop_count_are_preserved(tmp_path) -> None:
    project = Project(canvas_width=16, canvas_height=16, loop_count=3)
    durations = [1, 17, 250, 1000, 65535]
    for duration in durations:
        project.add_frame(
            Frame(solid_tile(4, 4, RED), x=0, y=0, duration_ms=duration)
        )
    path = export_apng(project, tmp_path / "durations.png")
    decoded = decode_apng(path)
    assert decoded.loop_count == 3
    assert [f.duration_ms for f in decoded.frames] == [
        float(d) for d in durations
    ]
    assert [f.duration_fraction for f in decoded.frames] == [
        (d, 1000) for d in durations
    ]


def test_infinite_loop_is_zero(tmp_path) -> None:
    project = sample_alpha_overlap()
    project.set_loop_count(0)
    path = export_apng(project, tmp_path / "infinite.png")
    decoded = decode_apng(path)
    assert decoded.loop_count == 0


# ------------------------------------------------------- independent reader
def test_independent_reader_matches_pillow(tmp_path) -> None:
    project = sample_restore_previous()
    path = export_apng(project, tmp_path / "pillow_check.png")
    with Image.open(path) as image:
        assert image.format == "PNG"
        assert image.n_frames == len(project.frames)
        for index in range(image.n_frames):
            image.seek(index)
            pixels = np.asarray(image.convert("RGBA"))
            decoded = decode_apng(path)
            assert np.array_equal(pixels, decoded.frames[index].pixels)


def test_unfilter_reconstruction_is_correct() -> None:
    # Known 2×2 RGBA image, encoded manually with Sub/Up/Average/Paeth rows.
    expected = np.array(
        [
            [[10, 20, 30, 255], [40, 50, 60, 255]],
            [[70, 80, 90, 128], [100, 110, 120, 0]],
        ],
        dtype=np.uint8,
    )

    def paeth(a, b, c):
        p = a + b - c
        pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
        return a if pa <= pb and pa <= pc else (b if pb <= pc else c)

    rows = []
    prev = bytes(8)
    for y in range(2):
        raw = expected[y].tobytes()
        if y == 0:
            filtered = bytes([(raw[i] - (raw[i - 4] if i >= 4 else 0)) & 0xFF for i in range(8)])
            rows.append(bytes([1]) + filtered)
        else:
            filtered = []
            for i in range(8):
                left = raw[i - 4] if i >= 4 else 0
                up = prev[i]
                up_left = prev[i - 4] if i >= 4 else 0
                filtered.append((raw[i] - paeth(left, up, up_left)) & 0xFF)
            rows.append(bytes([4]) + bytes(filtered))
        prev = raw
    decoded = _unfilter(b"".join(rows), width=2, height=2)
    assert np.array_equal(decoded, expected)


def test_reader_rejects_non_apng(tmp_path) -> None:
    from PIL import Image as PILImage

    path = tmp_path / "plain.png"
    PILImage.fromarray(np.zeros((4, 4, 4), dtype=np.uint8), "RGBA").save(path)
    with pytest.raises(APNGReadError, match="acTL"):
        decode_apng(path)


# ---------------------------------------------------- three named samples
def test_sample_alpha_overlap_readback(tmp_path) -> None:
    project = sample_alpha_overlap()
    path = export_apng(project, tmp_path / "alpha.png")
    decoded = decode_apng(path)

    frame1 = decoded.frames[0].pixels
    frame2 = decoded.frames[1].pixels
    assert pixel(frame1, 20, 20) == RED
    assert pixel(frame2, 40, 40) == expected_alpha_overlap_inside()
    assert pixel(frame2, 65, 65) == expected_alpha_overlap_outside()
    assert pixel(frame2, 65, 65) == SEMI_BLUE
    # No partially-transparent pixel was flattened against the checkerboard.
    assert pixel(frame2, 65, 65)[3] == 128
    report = verify_export(project, path)
    assert report.ok, report.summary()


def test_sample_move_and_clear_readback(tmp_path) -> None:
    project = sample_move_and_clear()
    path = export_apng(project, tmp_path / "move.png")
    decoded = decode_apng(path)

    assert pixel(decoded.frames[1].pixels, 41, 41) == (200, 40, 170, 255)
    assert pixel(decoded.frames[1].pixels, 5, 5) == GREEN
    assert pixel(decoded.frames[2].pixels, 5, 5) == GREEN
    assert pixel(decoded.frames[2].pixels, 45, 45) == (0, 0, 0, 0)
    assert pixel(decoded.frames[2].pixels, 12, 12) == expected_move_clear_overlap()
    assert pixel(decoded.frames[2].pixels, 12, 12) == expected_blend_over(GREEN, SEMI_YELLOW)
    report = verify_export(project, path)
    assert report.ok, report.summary()


def test_sample_restore_previous_readback(tmp_path) -> None:
    project = sample_restore_previous()
    path = export_apng(project, tmp_path / "restore.png")
    decoded = decode_apng(path)

    assert pixel(decoded.frames[1].pixels, 20, 20) == (30, 60, 200, 255)
    assert pixel(decoded.frames[2].pixels, 17, 17) == RED
    assert pixel(decoded.frames[2].pixels, 20, 20) == expected_restore_overlap()
    assert pixel(decoded.frames[2].pixels, 20, 20) == expected_blend_over(RED, SEMI_WHITE)
    report = verify_export(project, path)
    assert report.ok, report.summary()


# ------------------------------------------------------ verification logic
def test_verify_detects_pixel_mismatch(tmp_path, monkeypatch) -> None:
    project = sample_alpha_overlap()
    path = export_apng(project, tmp_path / "broken.png")
    tampered = project.copy()
    tampered.frames[0] = tampered.frames[0].clone(x=0, y=0)
    report = verify_export(tampered, path)
    assert not report.ok
    assert any("画面不一致" in problem for problem in report.problems)


def test_verify_detects_duration_mismatch(tmp_path) -> None:
    project = sample_alpha_overlap()
    path = export_apng(project, tmp_path / "durations.png")
    tampered = project.copy()
    tampered.frames[0] = tampered.frames[0].clone(duration_ms=251)
    report = verify_export(tampered, path)
    assert not report.ok
    assert any("时长不一致" in problem for problem in report.problems)


def test_verify_detects_loop_mismatch(tmp_path) -> None:
    project = sample_alpha_overlap()
    path = export_apng(project, tmp_path / "loop.png")
    tampered = project.copy()
    tampered.set_loop_count(7)
    report = verify_export(tampered, path)
    assert not report.ok
    assert any("循环行为不一致" in problem for problem in report.problems)


def test_millisecond_durations_are_written_exactly(tmp_path) -> None:
    """The writer uses delay_den = 1000, so integer ms needs no rounding.

    ``DURATION_TOLERANCE_MS`` only exists so that a re-encoded file using a
    different denominator (e.g. 1/100 s steps) can still be judged fairly; it
    is half a millisecond and therefore cannot hide a real 1 ms difference.
    """

    assert 0 < DURATION_TOLERANCE_MS <= 0.5 + 1e-6
    project = sample_alpha_overlap()
    path = export_apng(project, tmp_path / "exact.png")
    decoded = decode_apng(path)
    for expected, actual in zip(project.frames, decoded.frames):
        assert actual.duration_fraction == (expected.duration_ms, 1000)
        assert actual.duration_ms == float(expected.duration_ms)


def test_over_helper_is_independent_and_correct() -> None:
    assert tuple(_over(
        np.array([[[200, 30, 40, 255]]], dtype=np.uint8),
        np.array([[[0, 0, 200, 128]]], dtype=np.uint8),
    )[0, 0]) == (100, 15, 120, 255)
    # Transparent source leaves destination untouched.
    dst = np.array([[[7, 8, 9, 111]]], dtype=np.uint8)
    src = np.array([[[200, 100, 50, 0]]], dtype=np.uint8)
    assert tuple(_over(dst, src)[0, 0]) == (7, 8, 9, 111)
