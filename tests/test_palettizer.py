"""Tests for palette editing, quantisation invariants and indexed export.

These are headless: no Qt window is created except in the dedicated view test.
"""

from __future__ import annotations

import numpy as np
import pytest

from palettizer.demo import demo_rgba
from palettizer.palette import (
    MAX_COLORS,
    Palette,
    generate_palette,
    merge_duplicates,
)
from palettizer.pngio import (
    ExportError,
    encode_indexed_png,
    export_indexed_png,
    read_indexed_png,
    readback_matches,
)
from palettizer.quantize import (
    ALL_MODES,
    MODE_DIFFUSION,
    MODE_NONE,
    MODE_ORDERED,
    Quantizer,
    Settings,
    render_rgba,
)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def two_color_image(size=16):
    rgba = np.zeros((size, size, 4), dtype=np.uint8)
    rgba[:, : size // 2, :3] = (200, 30, 30)
    rgba[:, size // 2 :, :3] = (20, 40, 200)
    rgba[..., 3] = 255
    return rgba


def all_visible_px_in_palette(result) -> bool:
    vis = ~result.transparent_mask
    if not vis.any():
        return True
    used = np.unique(result.indices[vis])
    allowed = set(range(result.palette_colors.shape[0]))
    return all(int(i) in allowed for i in used)


# ---------------------------------------------------------------------------
# lock and palette membership invariants
# ---------------------------------------------------------------------------

def test_generation_keeps_locked_colours_untouched():
    rgba = demo_rgba("gradient_corners")
    opaque = rgba[..., 3] >= 128
    locked = Palette([(255, 0, 0), (0, 255, 0)], [True, True])
    palette, report = generate_palette(rgba, opaque, 12, locked)
    assert palette.colors[0] == (255, 0, 0)
    assert palette.colors[1] == (0, 255, 0)
    assert palette.locked[0] and palette.locked[1]
    assert len(palette) <= 12
    assert report.locked == 2
    # All locked colours keep their exact value, regardless of the image.
    for _ in range(3):
        again, _ = generate_palette(rgba, opaque, 12, palette)
        assert again.colors[:2] == [(255, 0, 0), (0, 255, 0)]
        assert again.locked[:2] == [True, True]


def test_generation_replaces_unlocked_colours_and_reports():
    rgba = demo_rgba("gradient_radial")
    opaque = rgba[..., 3] >= 128
    stale = Palette([(1, 2, 3), (4, 5, 6)])
    palette, report = generate_palette(rgba, opaque, 8, stale)
    assert (1, 2, 3) not in palette.colors
    assert (4, 5, 6) not in palette.colors
    assert "未锁定" in report.summary


def test_locked_colour_survives_dedupe_and_delete_is_refused():
    pal = Palette([(10, 10, 10), (10, 10, 10), (20, 20, 20)], [True, False, False])
    assert len(pal) == 2
    assert pal.colors[0] == (10, 10, 10)
    assert pal.locked[0] is True
    assert pal.delete(0) is False  # locked
    assert pal.delete(1) is True
    assert len(pal) == 1


def test_set_color_respects_lock_unless_forced():
    pal = Palette([(1, 2, 3)], [True])
    assert pal.set_color(0, (9, 9, 9)) is False
    assert pal.colors[0] == (1, 2, 3)
    assert pal.set_color(0, (9, 9, 9), force=True) is True
    assert pal.colors[0] == (9, 9, 9)


def test_duplicate_merge_is_reported():
    colors, locks, merged = merge_duplicates(
        [(1, 1, 1), (2, 2, 2), (1, 1, 1), (2, 2, 2), (3, 3, 3)], [True, False, False, False, False]
    )
    assert merged == 2
    assert colors == [(1, 1, 1), (2, 2, 2), (3, 3, 3)]
    assert locks[0] is True


def test_manual_palette_size_limits():
    with pytest.raises(ValueError):
        Palette([(i, i, i) for i in range(MAX_COLORS + 1)])
    with pytest.raises(ValueError):
        Palette([(0, 0, 0)], capacity=3)
    with pytest.raises(ValueError):
        generate_palette(two_color_image(), two_color_image()[..., 3] > 0, 33)


@pytest.mark.parametrize("target", [4, 8, 16, 32])
def test_every_visible_output_pixel_is_a_palette_member(target):
    rgba = demo_rgba("gradient_corners")
    opaque = rgba[..., 3] >= 128
    palette, _ = generate_palette(rgba, opaque, target)
    assert len(palette) <= target
    q = Quantizer(rgba)
    for mode in ALL_MODES:
        result = q.result(palette, Settings(mode=mode, strength=0.7))
        assert all_visible_px_in_palette(result)
        # Rendered pixels are exact palette colours.
        rendered = render_rgba(result)
        vis = ~result.transparent_mask
        cols = {tuple(c) for c in result.palette_colors.tolist()}
        assert {tuple(p) for p in rendered[vis, :3].tolist()} <= cols


def test_palette_never_exceeds_32_visible_colours_with_locks():
    rgba = demo_rgba("gradient_corners")
    opaque = rgba[..., 3] >= 128
    locked = Palette([(i * 8, 255 - i * 8, 128) for i in range(10)], [True] * 10)
    palette, report = generate_palette(rgba, opaque, 32, locked)
    assert len(palette) <= 32
    assert len({c for c in palette.colors}) == len(palette)


# ---------------------------------------------------------------------------
# transparency: hidden colour isolation and threshold
# ---------------------------------------------------------------------------

def test_fully_transparent_image_has_valid_result():
    rgba = demo_rgba("fully_transparent")
    opaque = rgba[..., 3] >= 128
    assert not opaque.any()
    palette, report = generate_palette(rgba, opaque, 16)
    assert len(palette) == 0
    assert report.produced == 0
    q = Quantizer(rgba)
    for mode in ALL_MODES:
        result = q.result(palette, Settings(mode=mode))
        assert result.transparent_mask.all()
        assert result.indices.max() == 0  # the single transparent index
        assert result.transparent_index == 0
        assert result.counts.sum() == 0


def test_hidden_rgb_under_transparency_does_not_affect_palette():
    # Same visible pixels, wildly different hidden RGB under alpha=0.
    a = np.zeros((8, 8, 4), dtype=np.uint8)
    a[2:6, 2:6, :3] = (120, 180, 240)
    a[2:6, 2:6, 3] = 255
    b = a.copy()
    b[a[..., 3] == 0, :3] = (255, 0, 255)
    c = a.copy()
    c[a[..., 3] == 0, :3] = (0, 255, 0)

    masks = a[..., 3] >= 128
    pal_a, _ = generate_palette(a, masks, 8)
    pal_b, _ = generate_palette(b, masks, 8)
    pal_c, _ = generate_palette(c, masks, 8)
    assert pal_a.colors == pal_b.colors == pal_c.colors

    qa, qb = Quantizer(a), Quantizer(b)
    for mode in ALL_MODES:
        ra = qa.result(pal_a, Settings(mode=mode))
        rb = qb.result(pal_b, Settings(mode=mode))
        assert np.array_equal(ra.indices, rb.indices)
        assert np.array_equal(ra.counts, rb.counts)
        assert np.array_equal(ra.transparent_mask, rb.transparent_mask)


def test_transparent_pixels_do_not_receive_or_forward_diffusion_error():
    """A visible strip that would otherwise spread error must not reach a
    visible pixel across a transparent gap.

    Layout (1 x 20):  black pixel, 17-pixel gap, target pixel.
    The palette is pure black / pure white.  With the gap *visible* and
    mid-grey, error diffusion alternates black/white through the strip and
    the target pixel is pulled to white.  With the same strip *transparent*
    (and a hidden bright magenta RGB), no error crosses the gap, so the
    target pixel quantises on its own and lands on black.
    """
    palette = Palette([(0, 0, 0), (255, 255, 255)])
    n = 20
    gap_grey = 160

    def make(gap_alpha, gap_rgb):
        rgba = np.zeros((1, n, 4), dtype=np.uint8)
        rgba[0, 0, :3] = (0, 0, 0)
        rgba[0, 0, 3] = 255
        rgba[0, 1 : n - 1, :3] = gap_rgb
        rgba[0, 1 : n - 1, 3] = gap_alpha
        rgba[0, n - 1, :3] = (110, 110, 110)
        rgba[0, n - 1, 3] = 255
        return rgba

    settings = Settings(mode=MODE_DIFFUSION, strength=1.0)
    transparent = Quantizer(make(0, (255, 0, 255))).result(palette, settings)
    visible = Quantizer(make(255, (gap_grey,) * 3)).result(palette, settings)

    # Baseline: a visible grey gap carries error, so the target goes white.
    assert palette.colors[int(visible.indices[0, n - 1])] == (255, 255, 255)
    # Isolated: transparent gap is a wall; the target stays black.
    assert palette.colors[int(transparent.indices[0, n - 1])] == (0, 0, 0)
    assert transparent.transparent_mask[0, 1 : n - 1].all()
    assert transparent.indices[0, 1 : n - 1].tolist() == [transparent.transparent_index] * (n - 2)

    # Hidden RGB inside the transparent gap cannot change any output.
    other = Quantizer(make(0, (0, 255, 0))).result(palette, settings)
    assert np.array_equal(transparent.indices, other.indices)
    assert np.array_equal(transparent.counts, other.counts)


def test_alpha_threshold_controls_visibility_and_counts():
    rgba = np.zeros((4, 4, 4), dtype=np.uint8)
    rgba[..., :3] = (90, 120, 240)
    # Column-wise alpha: 0, 30, 128, 200.
    rgba[..., 3] = np.array([0, 30, 128, 200], dtype=np.uint8)[None, :]
    palette = Palette([(90, 120, 240)])
    q = Quantizer(rgba)
    r128 = q.result(palette, Settings(alpha_threshold=128))
    assert r128.visible_mask[:, 2:].all()
    assert not r128.visible_mask[:, :2].any()
    r64 = q.result(palette, Settings(alpha_threshold=64))
    assert r64.visible_mask[:, 2:].all()
    assert not r64.visible_mask[:, 1].any()  # alpha 30 is below 64
    assert not r64.visible_mask[:, 0].any()  # alpha 0 is always transparent
    r16 = q.result(palette, Settings(alpha_threshold=16))
    assert r16.visible_mask[:, 1:].all()
    # Threshold only affects the mask; palette and usage follow it.
    assert r128.counts[0] == 8
    assert r16.counts[0] == 12


def test_semi_transparent_edge_preview_changes_with_threshold():
    rgba = demo_rgba("edge_glow")
    palette, _ = generate_palette(rgba, rgba[..., 3] >= 128, 12)
    q = Quantizer(rgba)
    vis = []
    for threshold in (40, 128, 220):
        result = q.result(palette, Settings(alpha_threshold=threshold))
        vis.append(int(result.visible_mask.sum()))
    assert vis[0] >= vis[1] >= vis[2]
    assert vis[0] > vis[2]


# ---------------------------------------------------------------------------
# determinism and stability
# ---------------------------------------------------------------------------

def test_repeated_computation_is_identical():
    rgba = demo_rgba("edge_glow")
    palette, _ = generate_palette(rgba, rgba[..., 3] >= 128, 10)
    q = Quantizer(rgba)
    for mode in ALL_MODES:
        a = q.result(palette, Settings(mode=mode, strength=0.6, alpha_threshold=100))
        b = q.result(palette, Settings(mode=mode, strength=0.6, alpha_threshold=100))
        assert np.array_equal(a.indices, b.indices)
        assert np.array_equal(a.counts, b.counts)


def test_generation_is_deterministic():
    rgba = demo_rgba("gradient_radial")
    opaque = rgba[..., 3] >= 128
    a, _ = generate_palette(rgba, opaque, 12)
    b, _ = generate_palette(rgba, opaque, 12)
    assert a.colors == b.colors


def test_ordered_dither_pattern_is_anchored_to_image_coordinates():
    # A uniform mid-grey image and a two-entry palette: the pattern depends
    # only on image coordinates.  Cropping an offset region must reproduce
    # the corresponding sub-block exactly.
    size = 32
    rgba = np.full((size, size, 4), 255, dtype=np.uint8)
    rgba[..., :3] = 120
    palette = Palette([(0, 0, 0), (255, 255, 255)])
    q = Quantizer(rgba)
    full = q.result(palette, Settings(mode=MODE_ORDERED, strength=1.0))

    offset = 8
    sub = rgba[offset : offset + 16, offset : offset + 16]
    sub_result = Quantizer(np.ascontiguousarray(sub)).result(
        palette, Settings(mode=MODE_ORDERED, strength=1.0)
    )
    # Same image coordinates => same dither decisions.
    assert np.array_equal(
        sub_result.indices, full.indices[offset : offset + 16, offset : offset + 16]
    )


def test_dither_strength_zero_matches_no_dither():
    rgba = demo_rgba("gradient_corners")
    palette, _ = generate_palette(rgba, rgba[..., 3] >= 128, 8)
    q = Quantizer(rgba)
    none = q.result(palette, Settings(mode=MODE_NONE))
    zero = q.result(palette, Settings(mode=MODE_ORDERED, strength=0.0))
    assert np.array_equal(none.indices, zero.indices)


# ---------------------------------------------------------------------------
# indexed PNG export / readback
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("demo", ["gradient_corners", "icon_star", "edge_glow", "fully_transparent"])
@pytest.mark.parametrize("mode", ALL_MODES)
def test_indexed_png_roundtrip_matches_preview(tmp_path, demo, mode):
    rgba = demo_rgba(demo)
    palette, _ = generate_palette(rgba, rgba[..., 3] >= 128, 16)
    q = Quantizer(rgba)
    settings = Settings(mode=mode, strength=0.65, alpha_threshold=110)
    result = q.result(palette, settings)

    path = tmp_path / f"{demo}_{mode}.png"
    meta = export_indexed_png(path, result, settings)
    assert path.exists()
    assert path.with_suffix(".json").exists()
    assert meta.visible_colors == [list(map(int, c)) for c in result.palette_colors.tolist()]

    readback = read_indexed_png(path)
    ok, message = readback_matches(result, readback)
    assert ok, message

    # The written file is genuinely indexed, not truecolour with a new name.
    data = path.read_bytes()
    assert data.startswith(b"\x89PNG\r\n\x1a\n")
    assert data[25] == 3  # IHDR colour type: 3 = indexed
    assert b"PLTE" in data and b"tRNS" in data

    # Visible pixels and transparent mask are byte-identical to the preview.
    visible = ~result.transparent_mask
    assert np.array_equal(readback.transparent_mask, result.transparent_mask)
    assert np.array_equal(readback.rgba[visible], render_rgba(result)[visible])
    assert not readback.rgba[~visible][:, 3].any()


def test_readback_rejects_truecolour_png(tmp_path):
    from PIL import Image

    path = tmp_path / "rgb.png"
    Image.new("RGB", (4, 4), (10, 20, 30)).save(path)
    with pytest.raises(ExportError):
        read_indexed_png(path)


def test_readback_rejects_semi_transparent_trns(tmp_path):
    indices = np.arange(16, dtype=np.uint8).reshape(4, 4) % 3
    palette = np.array([[10, 10, 10], [20, 20, 20]], dtype=np.uint8)
    data = encode_indexed_png(indices, palette, transparent_index=2)
    # Corrupt tRNS to hold a half-transparent alpha value.
    import struct
    import zlib

    fake_trns = b"\xff\x80\x00"
    pos = data.find(b"tRNS")
    length = struct.unpack(">I", data[pos - 4 : pos])[0]
    crc = zlib.crc32(b"tRNS" + fake_trns) & 0xFFFFFFFF
    mutated = data[: pos - 4] + struct.pack(">I", len(fake_trns)) + b"tRNS" + fake_trns + struct.pack(">I", crc) + data[pos + 4 + length + 4 :]
    path = tmp_path / "semi.png"
    path.write_bytes(mutated)
    with pytest.raises(ExportError):
        read_indexed_png(path)


def test_export_layout_keeps_transparent_index_outside_visible_budget(tmp_path):
    rgba = demo_rgba("icon_star")
    palette, _ = generate_palette(rgba, rgba[..., 3] >= 128, 4)
    result = Quantizer(rgba).result(palette, Settings(mode=MODE_NONE))
    path = tmp_path / "star.png"
    export_indexed_png(path, result, Settings(mode=MODE_NONE))
    readback = read_indexed_png(path)
    assert readback.transparent_index == readback.visible_color_count
    assert readback.visible_color_count == len(palette)
    # The transparent index is not one of the visible colours.
    assert readback.transparent_index not in set(range(readback.visible_color_count))


# ---------------------------------------------------------------------------
# session-level behaviour: edit / threshold updates stats and index map
# ---------------------------------------------------------------------------

def test_session_edits_update_counts_and_indices_and_undo():
    from palettizer.session import Session

    s = Session()
    s.load(demo_rgba("icon_heart"), "heart")
    s.generate(8)
    before = s.compute()
    before_counts = before.counts.copy()
    before_indices = before.indices.copy()

    # Recolour a slot that actually receives pixels, to a colour that is not
    # already in the palette.  Counts and the index map must update in sync.
    used_slots = [i for i, c in enumerate(before_counts) if c > 0]
    assert used_slots
    target = used_slots[-1]
    new_rgb = (7, 199, 83)
    assert not s.palette.contains(new_rgb)
    changed, merged = s.set_color(target, new_rgb, force=True)
    assert changed and merged == 0
    after = s.compute()
    assert after.counts.shape == before_counts.shape
    # Pixels no longer match the recoloured slot; they redistribute to the
    # remaining palette entries, so the total visible pixel count is stable
    # but the per-slot counts and the index map change together.
    assert int(after.counts.sum()) == int(before_counts.sum())
    assert int(after.counts[target]) != int(before_counts[target])
    assert not np.array_equal(after.indices, before_indices)
    # Rendered colour at that slot is exactly the requested palette entry.
    assert s.palette.colors[target] == new_rgb

    # Undo restores the exact previous palette, so the index map matches.
    s.undo()
    restored = s.compute()
    assert np.array_equal(restored.indices, before_indices)
    assert np.array_equal(restored.counts, before_counts)


def test_session_colour_edit_merges_duplicates_and_reports():
    from palettizer.session import Session

    s = Session()
    s.load(demo_rgba("icon_heart"), "heart")
    s.generate(8)
    before_len = len(s.palette)
    assert before_len >= 2
    changed, merged = s.set_color(1, s.palette.colors[0], force=True)
    assert changed
    assert merged == 1
    assert len(s.palette) == before_len - 1
    assert len(set(s.palette.colors)) == len(s.palette)


def test_session_alpha_threshold_syncs_stats():
    from palettizer.session import Session

    s = Session()
    s.load(demo_rgba("edge_glow"), "glow")
    s.generate(8)
    r1 = s.compute()
    s.set_settings(alpha_threshold=40)
    r2 = s.compute()
    assert int(r2.visible_mask.sum()) > int(r1.visible_mask.sum())
    assert r2.transparent_count < r1.transparent_count
    assert len(r2.counts) == len(s.palette)
    assert int(r2.counts.sum()) == int(r2.visible_mask.sum())


def test_session_undo_bounded_history():
    from palettizer.session import UNDO_LIMIT, Session

    s = Session()
    s.load(demo_rgba("icon_heart"), "heart")
    s.generate(6)
    for i in range(UNDO_LIMIT + 6):
        s.add_color((i, i, i)) if not s.palette.contains((i, i, i)) else None
    assert s.undo_depth <= UNDO_LIMIT
    # Every undo step returns a valid palette.
    while s.undo() is not None:
        assert len(s.palette) <= MAX_COLORS


# ---------------------------------------------------------------------------
# loading, manual palettes, export metadata
# ---------------------------------------------------------------------------

def test_load_png_keeps_dimensions_and_binary_alpha(tmp_path):
    from PIL import Image

    from palettizer.imageio import load_image

    arr = np.zeros((32, 48, 4), dtype=np.uint8)
    arr[..., :3] = (40, 120, 200)
    arr[..., 3] = np.tile(np.array([0, 60, 200, 255], dtype=np.uint8), 12)
    path = tmp_path / "semi.png"
    Image.fromarray(arr, mode="RGBA").save(path)
    loaded = load_image(path)
    assert loaded.shape == (32, 48, 4)
    assert np.array_equal(loaded, arr)


def test_load_rejects_oversized_and_non_png(tmp_path):
    from PIL import Image

    from palettizer.imageio import ImageLoadError, load_image

    big = tmp_path / "big.png"
    Image.new("RGBA", (257, 10), (0, 0, 0, 255)).save(big)
    with pytest.raises(ImageLoadError):
        load_image(big)
    jpg = tmp_path / "x.jpg"
    Image.new("RGB", (8, 8), (1, 2, 3)).save(jpg)
    with pytest.raises(ImageLoadError):
        load_image(jpg)


def test_manual_palette_outputs_stay_inside_manual_colours():
    manual = [(12, 34, 56), (200, 10, 10), (10, 200, 10), (10, 10, 200), (240, 240, 240)]
    palette = Palette(manual, [False, True, False, False, False])
    rgba = demo_rgba("edge_glow")
    q = Quantizer(rgba)
    for mode in ALL_MODES:
        result = q.result(palette, Settings(mode=mode, strength=0.9, alpha_threshold=90))
        vis = ~result.transparent_mask
        assert {tuple(c) for c in result.palette_colors.tolist()} == {tuple(c) for c in manual}
        assert {tuple(p) for p in render_rgba(result)[vis, :3].tolist()} <= set(manual)
        assert all_visible_px_in_palette(result)
    # The locked manual colour is still marked locked and unchanged.
    assert palette.locked[1] is True and palette.colors[1] == (200, 10, 10)


def test_export_sidecar_records_parameters_and_counts(tmp_path):
    import json

    rgba = demo_rgba("edge_glow")
    palette, _ = generate_palette(rgba, rgba[..., 3] >= 128, 10)
    settings = Settings(mode=MODE_ORDERED, strength=0.4, alpha_threshold=90)
    result = Quantizer(rgba).result(palette, settings)
    path = tmp_path / "meta.png"
    export_indexed_png(path, result, settings, notes="note-text")
    meta = json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))
    assert meta["mode"] == MODE_ORDERED
    assert meta["strength"] == pytest.approx(0.4)
    assert meta["alpha_threshold"] == 90
    assert meta["visible_colors"] == [list(map(int, c)) for c in result.palette_colors.tolist()]
    assert meta["counts"] == [int(v) for v in result.counts.tolist()]
    assert meta["transparent_index"] == result.transparent_index
    assert meta["transparent_count"] == result.transparent_count
    assert meta["image_size"] == [128, 128]
    assert meta["notes"] == "note-text"
