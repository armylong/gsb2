import numpy as np
import numpy.testing as npt
import pytest
from PIL import Image

from tileviewer.source import SourceError, file_sha256, load_source


def test_loads_png_and_hashes_content(tmp_path):
    from tests.conftest import write_png

    rng = np.random.default_rng(3)
    array = rng.integers(0, 256, (17, 23, 3), dtype=np.uint8)
    path = write_png(tmp_path / "a.png", array)
    source = load_source(path)
    assert (source.width, source.height) == (23, 17)
    npt.assert_array_equal(source.array, array)
    assert source.sha256 == file_sha256(path)
    assert not source.array.flags.writeable


def test_same_name_different_content_has_different_hash(tmp_path):
    from tests.conftest import write_png

    path = tmp_path / "same.png"
    write_png(path, np.zeros((8, 8, 3), np.uint8))
    first = load_source(path)
    write_png(path, np.full((8, 8, 3), 200, np.uint8))
    second = load_source(path)
    assert first.sha256 != second.sha256
    assert not first.same_file_as(second)


def test_read_rect_is_a_copy_and_bounds_checked(odd_rgb_array, source_png):
    from tileviewer.geometry import Rect

    source = load_source(source_png)
    patch = source.read_rect(Rect(3, 5, 10, 7))
    npt.assert_array_equal(patch, odd_rgb_array[5:12, 3:13, :])
    patch[0, 0, 0] = 1
    npt.assert_array_equal(source.array[5, 3], odd_rgb_array[5, 3])
    with pytest.raises(ValueError):
        source.read_rect(Rect(40, 30, 20, 20))


def test_rejects_grayscale(tmp_path):
    path = tmp_path / "gray.png"
    Image.fromarray(np.zeros((10, 10), np.uint8)).save(path)
    with pytest.raises(SourceError, match="not RGB|mode"):
        load_source(path)


def test_rejects_rgba(tmp_path):
    path = tmp_path / "rgba.png"
    Image.fromarray(np.zeros((10, 10, 4), np.uint8)).save(path)
    with pytest.raises(SourceError, match="not RGB|RGBA"):
        load_source(path)


def test_rejects_16bit_png(tmp_path):
    path = tmp_path / "deep.png"
    array = np.zeros((10, 10), np.uint16)
    Image.fromarray(array).save(path)
    with pytest.raises(SourceError):
        load_source(path)


def test_rejects_multipage_tiff_and_reads_single_page(tmp_path):
    import tifffile

    multi = tmp_path / "multi.tif"
    tifffile.imwrite(
        multi,
        np.zeros((4, 12, 10, 3), np.uint8),
        photometric="rgb",
    )
    with pytest.raises(SourceError, match="multi-page"):
        load_source(multi)

    single = tmp_path / "single.tif"
    data = np.random.default_rng(5).integers(0, 256, (9, 13, 3), dtype=np.uint8)
    tifffile.imwrite(single, data, photometric="rgb")
    source = load_source(single)
    assert (source.width, source.height) == (13, 9)
    npt.assert_array_equal(source.array, data)


def test_tiff_planar_channels_first_is_transposed(tmp_path):
    import tifffile

    shape = (3, 11, 7)
    data = np.random.default_rng(7).integers(0, 256, shape, dtype=np.uint8)
    path = tmp_path / "planar.tif"
    tifffile.imwrite(path, data, photometric="rgb", planarconfig="separate")
    source = load_source(path)
    assert (source.width, source.height) == (7, 11)
    npt.assert_array_equal(source.array, data.transpose(1, 2, 0))


def test_missing_file_and_empty_file(tmp_path):
    with pytest.raises(SourceError, match="not found"):
        load_source(tmp_path / "nope.png")
    empty = tmp_path / "empty.png"
    empty.write_bytes(b"")
    with pytest.raises(SourceError, match="empty"):
        load_source(empty)


def test_animated_gif_rejected(tmp_path):
    frames = [Image.new("RGB", (8, 8), (i * 10, 0, 0)) for i in range(3)]
    path = tmp_path / "anim.gif"
    frames[0].save(path, save_all=True, append_images=frames[1:])
    with pytest.raises(SourceError, match="multi-frame"):
        load_source(path)
