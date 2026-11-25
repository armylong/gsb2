from mosaic_studio.config import MosaicParams
from mosaic_studio.features import extract_feature, feature_distance
from mosaic_studio.generator import make_pattern_tile


def test_same_mean_different_texture_is_distinguishable():
    flat = make_pattern_tile((128, 128, 128), "flat", seed=1)
    stripes = make_pattern_tile((128, 128, 128), "hstripes", amp=64, seed=2)
    dots = make_pattern_tile((128, 128, 128), "dots", amp=64, seed=3)

    f_flat = extract_feature(flat)
    f_stripes = extract_feature(stripes)
    f_dots = extract_feature(dots)

    # 平均颜色确实几乎一致（掩膜做过去均值处理）。
    assert abs(f_flat.mean_rgb[0] - f_stripes.mean_rgb[0]) < 2.5
    assert abs(f_flat.mean_rgb[0] - f_dots.mean_rgb[0]) < 2.5

    p = MosaicParams()
    d_flat_stripes = feature_distance(f_flat, f_stripes, p.normalized_weights())
    d_flat_dots = feature_distance(f_flat, f_dots, p.normalized_weights())
    d_stripes_dots = feature_distance(f_stripes, f_dots, p.normalized_weights())
    # 同色异纹的距离应当明显大于两张几乎相同的平涂色。
    flat2 = make_pattern_tile((127, 128, 129), "flat", seed=4)
    d_twin_flat = feature_distance(f_flat, extract_feature(flat2),
                                   p.normalized_weights())
    assert d_flat_stripes > d_twin_flat * 3
    assert d_flat_dots > d_twin_flat * 3
    assert d_stripes_dots > d_twin_flat * 3


def test_distance_bounds_and_symmetry():
    a = extract_feature(make_pattern_tile((20, 30, 200), "checker", seed=5))
    b = extract_feature(make_pattern_tile((220, 180, 40), "waves", seed=6))
    w = MosaicParams().normalized_weights()
    dab = feature_distance(a, b, w)
    dba = feature_distance(b, a, w)
    assert 0.0 <= dab <= 1.0
    assert abs(dab - dba) < 1e-12
    assert feature_distance(a, a, w) < 1e-9
