import numpy as np
import numpy.testing as npt
import pytest

from tileviewer.exporter import export_region, save_export
from tileviewer.geometry import Rect


@pytest.fixture
def source():
    height, width = 61, 83
    ys, xs = np.mgrid[0:height, 0:width]
    return np.stack(
        [xs % 256, ys % 256, (xs + ys) % 256], axis=2
    ).astype(np.uint8)


def test_exact_inside_crop(source):
    rect = Rect(11, 7, 30, 21)
    result = export_region(source, rect)
    assert result.size == (30, 21)
    assert result.outside_pixels == 0
    npt.assert_array_equal(
        np.array(result.image.convert("RGB")),
        source[7:28, 11:41, :],
    )


def test_selection_across_tile_borders_is_still_an_exact_crop(source):
    # 16px tiles means this crosses many tile borders.
    rect = Rect(13, 9, 41, 37)
    result = export_region(source, rect)
    npt.assert_array_equal(
        np.array(result.image.convert("RGB")),
        source[9:46, 13:54, :],
    )


def test_exact_mode_keeps_size_when_crossing_edge(source):
    rect = Rect(70, 50, 30, 30)  # extends past right (83) and bottom (61)
    result = export_region(source, rect, fill="transparent")
    assert result.size == (30, 30)
    assert result.image.mode == "RGBA"
    assert result.outside_pixels == 30 * 30 - 13 * 11
    array = np.array(result.image)
    # Inside part matches the original.
    npt.assert_array_equal(array[:11, :13, :3], source[50:61, 70:83, :])
    assert (array[:11, :13, 3] == 255).all()
    # Outside part is fully transparent.
    assert (array[11:, :, 3] == 0).all()
    assert (array[:, 13:, 3] == 0).all()


def test_clip_mode_narrows_output(source):
    rect = Rect(-10, -5, 30, 20)
    result = export_region(source, rect, size_mode="clip")
    assert result.size == (20, 15)
    assert result.outside_pixels == 0
    npt.assert_array_equal(
        np.array(result.image.convert("RGB")), source[0:15, 0:20, :]
    )


def test_clip_mode_rejects_fully_outside():
    with pytest.raises(ValueError):
        export_region(
            np.zeros((10, 10, 3), np.uint8),
            Rect(20, 20, 5, 5),
            size_mode="clip",
        )


def test_opaque_fill_colours(source):
    for fill, value in (("black", 0), ("white", 255)):
        result = export_region(source, Rect(-4, -4, 10, 10), fill=fill)
        array = np.array(result.image)
        assert result.image.mode == "RGB"
        assert array.shape == (10, 10, 3)
        assert (array[:4, :, :] == value).all()
        assert (array[:, :4, :] == value).all()
        npt.assert_array_equal(array[4:, 4:, :], source[0:6, 0:6, :])


def test_fully_outside_selection_with_exact_mode(source):
    result = export_region(source, Rect(-20, -20, 8, 6), fill="white")
    assert result.size == (8, 6)
    assert result.outside_pixels == 48
    assert (np.array(result.image) == 255).all()


def test_invalid_inputs(source):
    with pytest.raises(ValueError):
        export_region(source, Rect(0, 0, 0, 5))
    with pytest.raises(ValueError):
        export_region(source, Rect(0, 0, 5, 5), fill="magenta")
    with pytest.raises(ValueError):
        export_region(source, Rect(0, 0, 5, 5), size_mode="stretch")


def test_save_lossless_png_and_tiff(tmp_path, source):
    result = export_region(source, Rect(5, 5, 17, 13))
    png = save_export(result, tmp_path / "crop.png")
    tif = save_export(result, tmp_path / "crop.tif")
    from PIL import Image

    with Image.open(png) as image:
        npt.assert_array_equal(
            np.array(image.convert("RGB")), source[5:18, 5:22, :]
        )
    with Image.open(tif) as image:
        npt.assert_array_equal(
            np.array(image.convert("RGB")), source[5:18, 5:22, :]
        )


def test_jpeg_refuses_transparent_padding(tmp_path, source):
    result = export_region(source, Rect(-2, -2, 10, 10), fill="transparent")
    with pytest.raises(ValueError, match="JPEG"):
        save_export(result, tmp_path / "crop.jpg")
    opaque = export_region(source, Rect(-2, -2, 10, 10), fill="black")
    assert save_export(opaque, tmp_path / "ok.jpg").exists()
