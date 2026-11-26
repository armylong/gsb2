import os

import pytest
from PIL import Image

from cropkit.imaging import (export_crops, marker_mask, open_image,
                             results_to_rows, sanitize_filename,
                             verify_export_edges, write_manifest)
from cropkit.project import CropItem, Marker
from cropkit.rectmath import Rect
from cropkit.samples import make_sheet, save_with_orientation


@pytest.fixture
def loaded(tmp_path):
    path = tmp_path / "src.jpg"
    save_with_orientation(make_sheet(True, (320, 240)), str(path), 6,
                          quality=96)
    return open_image(str(path))


def test_orientation_is_applied_once(loaded):
    assert loaded.orientation.value == 6
    assert loaded.stored_size == (240, 320)
    assert loaded.display_size == (320, 240)


def test_crop_size_is_exact(loaded):
    rect = Rect.from_size(11, 13, 37, 29)
    piece = loaded.upright_crop(rect)
    assert piece.size == (37, 29)


def test_crop_is_a_slice_not_a_resample(loaded):
    rect = Rect.from_size(11, 13, 37, 29)
    piece = loaded.upright_crop(rect)
    same = loaded.display.crop((11, 13, 48, 42))
    assert piece.tobytes() == same.tobytes()


def test_border_crop_keeps_last_row_and_column(loaded):
    w, h = loaded.display_size
    rect = Rect.from_size(w - 20, h - 10, 20, 10)
    piece = loaded.upright_crop(rect)
    assert piece.size == (20, 10)
    # last row of the crop == last row of the source
    assert piece.crop((0, 9, 20, 10)).tobytes() == \
        loaded.display.crop((w - 20, h - 1, w, h)).tobytes()
    assert piece.crop((19, 0, 20, 10)).tobytes() == \
        loaded.display.crop((w - 1, h - 10, w, h)).tobytes()


def test_out_of_bounds_crop_clamps_without_shifting(loaded):
    w, h = loaded.display_size
    rect = Rect(-10, -10, w + 10, h + 10)
    piece = loaded.upright_crop(rect)
    assert piece.size == (w, h)
    assert piece.tobytes() == loaded.display.tobytes()


def test_export_writes_png_and_mask(loaded, tmp_path):
    out = tmp_path / "out"
    crops = [CropItem("甲", Rect.from_size(10, 10, 40, 30))]
    markers = [Marker("内", 15, 15), Marker("外", 100, 100)]
    results = export_crops(loaded, crops, markers, str(out))
    assert len(results) == 1
    result = results[0]
    assert result.crop_path.endswith(".png")
    assert result.mask_path.endswith(".png")
    with Image.open(result.crop_path) as png:
        assert png.size == (40, 30)
    with Image.open(result.mask_path) as mask:
        assert mask.size == (40, 30)
        assert mask.getpixel((5, 5)) == 255
    rows = results_to_rows(results)
    statuses = {(r["marker"], r["status"]) for r in rows}
    assert ("内", "已包含") in statuses
    assert ("外", "未包含") in statuses
    outside = next(r for r in rows if r["marker"] == "外")
    # the converted local position is reported even though it is outside
    assert outside["local"] == "90, 90"
    assert "右下" in outside["note"] or "右" in outside["note"] or \
        "下" in outside["note"]


def test_export_row_reports_included_position(loaded, tmp_path):
    crops = [CropItem("甲", Rect.from_size(10, 20, 40, 30))]
    results = export_crops(loaded, crops, [Marker("内", 15, 25)],
                           str(tmp_path / "o"))
    row = results_to_rows(results)[0]
    assert row["local"] == "5, 5"
    assert (row["x"], row["y"]) == (15, 25)


def test_rows_without_markers(loaded, tmp_path):
    results = export_crops(loaded, [CropItem("甲", Rect.from_size(0, 0, 5, 5))],
                           [], str(tmp_path / "o"))
    assert results_to_rows(results)[0]["status"] == "无定点"


def test_disabled_crops_are_skipped(loaded, tmp_path):
    crops = [CropItem("甲", Rect.from_size(0, 0, 10, 10)),
             CropItem("乙", Rect.from_size(20, 20, 10, 10), enabled=False)]
    results = export_crops(loaded, crops, [], str(tmp_path / "o"))
    assert [r.name for r in results] == ["甲"]


def test_duplicate_names_get_unique_files(loaded, tmp_path):
    crops = [CropItem("同名", Rect.from_size(0, 0, 10, 10)),
             CropItem("同名", Rect.from_size(20, 20, 10, 10))]
    results = export_crops(loaded, crops, [], str(tmp_path / "o"))
    assert results[0].crop_path != results[1].crop_path
    assert os.path.basename(results[1].crop_path) == "同名_2.png"


def test_manifest_and_verification(loaded, tmp_path):
    out = tmp_path / "o"
    results = export_crops(
        loaded, [CropItem("甲", Rect.from_size(3, 5, 61, 47))],
        [Marker("m", 10, 10)], str(out))
    manifest = out / "m.json"
    write_manifest(results, str(manifest))
    assert manifest.exists()
    checks = verify_export_edges(loaded, results)
    assert checks and all(ok for _, ok, _ in checks)


def test_verify_detects_a_shifted_file(loaded, tmp_path):
    out = tmp_path / "o"
    results = export_crops(loaded, [CropItem("甲", Rect.from_size(0, 0, 30, 20))],
                           [], str(out))
    # simulate an off-by-one export
    with Image.open(results[0].crop_path) as png:
        shifted = png.crop((1, 0, 31, 20))
    shifted.save(results[0].crop_path)
    checks = verify_export_edges(loaded, results)
    assert checks and not checks[0][1]
    assert "左" in checks[0][2] or "右" in checks[0][2]


def test_sanitize_filename():
    assert sanitize_filename("a/b:c") == "abc"
    assert sanitize_filename("  ") == "crop"
    assert sanitize_filename("带 空格") == "带_空格"


def test_marker_mask_dot():
    mask = marker_mask(Rect.from_size(0, 0, 20, 20), [(10, 10)], dot=2)
    assert mask.getpixel((10, 10)) == 255
    assert mask.getpixel((12, 10)) == 255
    assert mask.getpixel((18, 18)) == 0
