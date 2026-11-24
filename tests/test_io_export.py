"""I/O and export tests."""
from __future__ import annotations

import csv

import numpy as np
import pytest
from PIL import Image

from maskdiff import samples
from maskdiff.core import Calibration, Roi, analyze
from maskdiff.export import (
    export_difference_png,
    export_hole_csv,
    export_region_csv,
    export_summary_csv,
)
from maskdiff.io import MaskLoadError, load_mask_png, save_mask_png


def _read_csv(path) -> list[list[str]]:
    with open(path, newline="", encoding="utf-8-sig") as fh:
        return list(csv.reader(fh))


# ---------------------------------------------------------------------- I/O
def test_save_and_load_roundtrip(tmp_path):
    mask = samples.translation()[0]
    p = save_mask_png(mask, tmp_path / "a.png")
    loaded = load_mask_png(p)
    assert np.array_equal(loaded, mask)


def test_load_rgba_with_transparency(tmp_path):
    rgba = np.zeros((4, 4, 4), dtype=np.uint8)
    rgba[1, 1] = (255, 255, 255, 255)
    rgba[2, 2] = (255, 255, 255, 0)  # transparent white -> background
    p = tmp_path / "rgba.png"
    Image.fromarray(rgba, "RGBA").save(p)
    m = load_mask_png(p)
    assert m[1, 1]
    assert not m[2, 2]


def test_load_palette_image(tmp_path):
    im = Image.new("P", (4, 4), 0)
    im.putpalette([0, 0, 0, 255, 0, 0] + [0] * 762)
    im.putpixel((0, 0), 1)
    p = tmp_path / "p.png"
    im.save(p)
    m = load_mask_png(p)
    assert m[0, 0]
    assert not m[1, 1]


def test_load_missing_file(tmp_path):
    with pytest.raises(MaskLoadError, match="不存在"):
        load_mask_png(tmp_path / "nope.png")


def test_load_non_image(tmp_path):
    p = tmp_path / "x.png"
    p.write_text("not an image")
    with pytest.raises(MaskLoadError):
        load_mask_png(p)


# ------------------------------------------------------------------- export
@pytest.fixture()
def diff():
    a, b = samples.notch()
    return analyze(a, b, calib=Calibration(row_size=0.5, col_size=0.25, tolerance=2.0, unit="mm"))


def test_export_difference_png(diff, tmp_path):
    p = export_difference_png(diff, tmp_path / "diff.png")
    im = Image.open(p)
    assert im.mode == "RGBA"
    assert im.size == (diff.shape[1], diff.shape[0])
    arr = np.asarray(im)
    # A-only pixel is transparent for the notch example; B-only is orange.
    r, c = np.argwhere(diff.only_b)[0]
    assert tuple(arr[r, c][:3]) == (0xEB, 0x68, 0x34)
    r2, c2 = np.argwhere(diff.overlap)[0]
    assert tuple(arr[r2, c2][:3]) == (0x1B, 0xAF, 0x7A)


def test_export_summary_csv_uses_one_unit(diff, tmp_path):
    p = export_summary_csv(diff, tmp_path / "summary.csv")
    rows = _read_csv(p)
    flat = "\n".join(",".join(r) for r in rows)
    assert "mm" in flat
    assert "mm²" in flat
    header = rows[0]
    assert header[1] == "A→B" and header[2] == "B→A"
    max_row = next(r for r in rows if r and r[0].startswith("最大距离"))
    # Notch depth 22 px * 0.5 mm/row = 11 mm in the A->B direction.
    assert float(max_row[1]) == pytest.approx(11.0)


def test_export_region_csv(diff, tmp_path):
    p = export_region_csv(diff, tmp_path / "regions.csv")
    rows = _read_csv(p)
    assert rows[0][0] == "类型"
    assert len(rows) == 1 + len(diff.regions)
    assert any(r[0] == "B 独有" for r in rows[1:])


def test_export_hole_csv_keeps_one_pixel_hole(tmp_path):
    a, b = samples.pinhole((80, 80), 1)
    d = analyze(a, b)
    p = export_hole_csv(d, tmp_path / "holes.csv")
    rows = _read_csv(p)
    assert len(rows) == 2
    assert rows[1][0] == "A"
    assert rows[1][2] == "1"


def test_export_summary_records_roi(tmp_path):
    a, b = samples.notch()
    d = analyze(a, b, roi=Roi(20, 90, 100, 160))
    p = export_summary_csv(d, tmp_path / "s.csv")
    flat = "\n".join(",".join(r) for r in _read_csv(p))
    assert "20,90,100,160" in flat
