import pytest
from PIL import Image

from cropkit.orientation import Orientation, normalize
from cropkit.samples import stored_pixels_for
from cropkit.rectmath import Rect


def gradient(w, h):
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = (x * 7 % 256, y * 11 % 256, (x + y) * 3 % 256)
    return img


@pytest.mark.parametrize("value", range(1, 9))
def test_stored_and_display_are_inverses(value):
    """Encoding an upright image and decoding it must return the original.

    ``stored_pixels_for`` is the same transform the sample writer uses, so
    this pins the orientation table to actual pixel behaviour.
    """
    img = gradient(13, 9)
    stored = stored_pixels_for(img, value)
    assert Orientation(value).to_display(stored).tobytes() == \
        img.tobytes("raw", "RGB")
    assert Orientation(value).to_display(stored).size == img.size


@pytest.mark.parametrize("value", range(1, 9))
def test_point_mapping_matches_pixels(value):
    img = gradient(13, 9)
    o = Orientation(value)
    display = o.to_display(img)
    w, h = display.size
    src = img.load()
    dst = display.load()
    for y in range(h):
        for x in range(w):
            sx, sy = o.to_stored_mapping((x, y), (w, h))
            assert dst[x, y] == src[sx, sy]
            bx, by = o.from_stored_mapping((sx, sy), (w, h))
            assert (bx, by) == (x, y)


@pytest.mark.parametrize("value", range(1, 9))
def test_display_rect_round_trips(value):
    o = Orientation(value)
    display_size = (30, 20)
    stored_size = o.stored_size(display_size)
    rect = Rect.from_size(2, 3, 11, 7)
    stored = o.display_rect_to_stored(rect, display_size)
    expect = (7, 11) if o.swaps_axes else (11, 7)
    assert stored.size == expect
    assert 0 <= stored.x0 and stored.x1 <= stored_size[0]
    assert 0 <= stored.y0 and stored.y1 <= stored_size[1]
    back = o.stored_rect_to_display(stored, display_size)
    assert back == rect


def test_sizes():
    assert Orientation(6).stored_size((10, 20)) == (20, 10)
    assert Orientation(6).display_size((20, 10)) == (10, 20)
    assert Orientation(3).stored_size((10, 20)) == (10, 20)


def test_normalize():
    assert normalize(0) == 1
    assert normalize(9) == 1
    assert normalize(None) == 1
    assert normalize("6") == 6


def test_corner_mapping_matches_pixels():
    img = gradient(11, 7)
    for value in range(1, 9):
        o = Orientation(value)
        display = o.to_display(img)
        sources = o.corner_sources()
        dw, dh = display.size
        sw, sh = img.size
        for dc, sc in sources.items():
            dx = 0 if dc.endswith("L") else dw - 1
            dy = 0 if dc.startswith("T") else dh - 1
            sx = 0 if sc.endswith("L") else sw - 1
            sy = 0 if sc.startswith("T") else sh - 1
            assert display.getpixel((dx, dy)) == img.getpixel((sx, sy))
