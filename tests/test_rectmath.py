from cropkit.rectmath import (Rect, handle_at, parse_ratio, resize_handle,
                              tighten, union)


def test_size_is_derived_from_edges():
    r = Rect(5, 6, 17, 20)
    assert r.size == (12, 14)
    assert r.as_tuple() == (5, 6, 12, 14)


def test_from_floats_rounds_edges_not_sizes():
    r = Rect.from_floats(0.4, 0.6, 10.2, 10.2)
    # edges are rounded independently: x1 = round(10.6) = 11
    assert r.as_tuple()[:2] == (0, 1)
    assert r.x1 == 11 and r.y1 == 11


def test_clamp_keeps_size_and_exact_border():
    r = Rect.from_size(95, 95, 10, 10)
    c = r.clamped_to(100, 100)
    assert c.size == (10, 10)
    assert c.x1 == 100 and c.y1 == 100


def test_clamp_oversize_shrinks_to_image():
    c = Rect(-5, -5, 120, 120).clamped_to(100, 80)
    assert c.as_tuple() == (0, 0, 100, 80)


def test_clamp_negative_near_edge():
    c = Rect.from_size(-3, 10, 10, 10).clamped_to(100, 100)
    assert c.x0 == 0 and c.size == (10, 10)


def test_tighten_area_and_center():
    r = Rect.from_size(0, 0, 100, 100)
    t = tighten(r, (4, 3))
    assert t.size == (100, 75)
    assert t.y0 == 12  # centered
    t2 = tighten(r, (3, 4))
    assert t2.size == (75, 100)


def test_tighten_never_grows():
    r = Rect.from_size(0, 0, 30, 10)
    t = tighten(r, (1, 1))
    assert t.size == (10, 10)


def test_parse_ratio():
    assert parse_ratio("4:3") == (4.0, 3.0)
    assert parse_ratio("4／3") is None
    assert parse_ratio("4/3") == (4.0, 3.0)
    assert parse_ratio("1.5") == (1.5, 1.0)
    assert parse_ratio("") is None
    assert parse_ratio("0:3") is None
    assert parse_ratio("abc") is None


def test_handles():
    r = Rect.from_size(10, 10, 100, 50)
    assert handle_at(r, 110, 60, 5) == 7
    # (60, 60) is the bottom-middle handle of this rect
    assert handle_at(r, 60, 60, 5) == 6
    assert handle_at(r, 60, 40, 5) is None
    assert handle_at(r, 10, 10, 2) == 0


def test_resize_free_bottom_right():
    r = Rect.from_size(10, 10, 100, 50)
    out = resize_handle(r, 7, 20, 10)
    assert out == Rect.from_size(10, 10, 120, 60)


def test_resize_ratio_right_edge_drives_height():
    r = Rect.from_size(0, 0, 200, 100)
    out = resize_handle(r, 4, 100, 0, (1, 1))
    assert out.width == out.height == 300


def test_resize_ratio_corner():
    r = Rect.from_size(0, 0, 200, 100)
    out = resize_handle(r, 7, 50, 0, (4, 3))
    assert abs(out.width / out.height - 4 / 3) < 0.02


def test_resize_clipped_to_bounds():
    r = Rect.from_size(90, 90, 10, 10)
    out = resize_handle(r, 7, 50, 50, bounds=(100, 100))
    assert out.x1 <= 100 and out.y1 <= 100
    assert out.size == (10, 10)


def test_union():
    assert union([]) is None
    assert union([Rect.from_size(0, 0, 5, 5),
                  Rect.from_size(10, 10, 5, 5)]).as_tuple() == (0, 0, 15, 15)


def test_intersects():
    a = Rect.from_size(0, 0, 10, 10)
    assert a.intersects(Rect.from_size(9, 9, 5, 5))
    assert not a.intersects(Rect.from_size(10, 0, 5, 5))


def test_contains_is_half_open():
    r = Rect.from_size(5, 5, 10, 10)
    assert r.contains(5, 5)
    assert r.contains(14, 14)
    assert not r.contains(15, 14)
    assert not r.contains(4, 5)
