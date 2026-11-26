import math

import numpy as np
import pytest

from ambi_rotate.dsp import (
    DIR_CCW,
    DIR_CW,
    DIR_SHORTEST,
    IDX_W,
    IDX_X,
    IDX_Y,
    IDX_Z,
    MODE_DIR,
    MODE_FULL,
    MODE_OMNI,
    YawMarkers,
    decode_stereo,
    fuma_to_ambix,
    intensity_azimuth,
    level_db,
    plane_wave,
    render_stereo,
    rotate_yaw,
)
from ambi_rotate.validation import run_all_checks


@pytest.fixture
def sig():
    rng = np.random.default_rng(3)
    return rng.standard_normal(4800) * 0.5


def test_plane_wave_rotation_shifts_azimuth(sig):
    for az in (-170.0, -33.0, 0.0, 60.0, 90.0, 145.0):
        b = plane_wave(az, sig)
        for yaw in (-200.0, -90.0, 0.0, 37.0, 180.0, 270.0, 360.0, 720.0):
            rot = rotate_yaw(b, math.radians(yaw))
            got = math.degrees(intensity_azimuth(rot)) % 360.0
            assert got == pytest.approx((az - yaw) % 360.0, abs=1e-9)


def test_full_turn_identity_and_half_turn(sig):
    b = plane_wave(55.0, sig)
    assert np.allclose(rotate_yaw(b, math.radians(360.0)), b, atol=1e-12)
    assert np.allclose(rotate_yaw(b, math.radians(-360.0)), b, atol=1e-12)
    half = rotate_yaw(b, math.radians(180.0))
    assert math.degrees(intensity_azimuth(half)) % 360.0 == pytest.approx(
        (55.0 - 180.0) % 360.0, abs=1e-9)
    # W 与 Z 在水平旋转中严格不变
    assert np.array_equal(half[:, IDX_W], b[:, IDX_W])
    assert np.array_equal(half[:, IDX_Z], b[:, IDX_Z])


def test_left_right_pan_and_speaker_angle(sig):
    b_l = plane_wave(90.0, sig)
    st = decode_stereo(b_l, 90.0)
    assert np.all(np.abs(st[:, 1]) < 1e-12)  # 正左 -> 右扬声器零输出
    assert np.mean(st[:, 0] ** 2) > 0
    b_r = plane_wave(-90.0, sig)
    st = decode_stereo(b_r, 90.0)
    assert np.all(np.abs(st[:, 0]) < 1e-12)
    # 正前方在任意夹角下 L/R 等幅
    b_f = plane_wave(0.0, sig)
    for phi in (30.0, 60.0, 90.0, 150.0):
        s = decode_stereo(b_f, phi)
        assert np.allclose(s[:, 0], s[:, 1])


def test_omni_directional_partition(sig):
    b = plane_wave(42.0, sig)
    full = decode_stereo(b, 90.0, MODE_FULL)
    omni = decode_stereo(b, 90.0, MODE_OMNI)
    dire = decode_stereo(b, 90.0, MODE_DIR)
    assert np.allclose(full, omni + dire)
    # omni 模式两耳等幅, 且就是 0.5*W
    assert np.allclose(omni[:, 0], omni[:, 1])
    assert np.allclose(omni[:, 0], 0.5 * b[:, IDX_W])
    # 单通道 solo
    for ch in range(4):
        solo = decode_stereo(b, 90.0, f"solo{ch}")
        assert solo.shape == (b.shape[0], 2)


def test_solo_y_nothing_from_front_source(sig):
    b = plane_wave(0.0, sig)                # 正前方 -> Y=0
    solo_y = decode_stereo(b, 90.0, "solo1")
    assert np.all(solo_y == 0.0)
    # 正前方平面波的 Y 通道恒为 0, 上面严格为零; 再验证随机信号下仅由该路贡献
    rng = np.random.default_rng(11)
    b2 = rng.standard_normal((1000, 4))
    solo = decode_stereo(b2, 90.0, "solo1")
    expect = (b2[:, 1] / (2 * math.sqrt(3.0)))[:, None] * np.array([1.0, -1.0])
    assert np.allclose(solo, expect)


def test_level_meter_values():
    x = np.ones(1000) * 0.5
    rms, peak = level_db(x)
    assert rms == pytest.approx(20 * math.log10(0.5), abs=1e-12)
    assert peak == pytest.approx(rms, abs=1e-12)
    rms0, peak0 = level_db(np.zeros(10))
    assert math.isinf(rms0) and math.isinf(peak0)


def test_marker_directions_and_wrap():
    # 350 -> 10: 逆时针跨 0 走 +20, 顺时针走 -340
    mk = YawMarkers([(0, 350), (1, 10)], DIR_CCW)
    assert mk.yaw_at(0.5) == pytest.approx(0.0, abs=1e-9)
    mk_cw = YawMarkers([(0, 350), (1, 10)], DIR_CW)
    # 顺时针 delta=-340, 中点 350-170=180
    assert mk_cw.yaw_at(0.5) == pytest.approx(180.0, abs=1e-9)
    mk_s = YawMarkers([(0, 350), (1, 10)], DIR_SHORTEST)
    assert mk_s.yaw_at(0.5) == pytest.approx(0.0, abs=1e-9)
    # 反向: 10 -> 350 顺时针跨 0 走 -20
    mk_cw2 = YawMarkers([(0, 10), (1, 350)], DIR_CW)
    assert mk_cw2.yaw_at(0.5) == pytest.approx(0.0, abs=1e-9)
    mk_ccw2 = YawMarkers([(0, 10), (1, 350)], DIR_CCW)
    assert mk_ccw2.yaw_at(0.5) == pytest.approx(180.0, abs=1e-9)
    # 端点保持
    assert mk.yaw_at(-1) == pytest.approx(350.0)
    assert mk.yaw_at(5) == pytest.approx(10.0)
    # 转一圈: 0 -> 360 单调, 不出现跨界反绕
    mk2 = YawMarkers([(0, 0), (2, 360)], DIR_CCW)
    assert mk2.yaw_at(1) == pytest.approx(180.0)
    assert mk2.yaw_at(1.999) == pytest.approx(359.82, abs=1e-6)


def test_render_deterministic_and_independent_of_position(sig):
    b = plane_wave(20.0, sig)
    sr = 48000
    a = render_stereo(b, sr, 75.0, MODE_FULL, fixed_yaw_deg=33,
                      start_time=0.02, end_time=0.08)
    b2 = render_stereo(b, sr, 75.0, MODE_FULL, fixed_yaw_deg=33,
                       start_time=0.02, end_time=0.08)
    assert np.array_equal(a, b2)
    assert a.shape == (int(round(0.06 * sr)), 2)
    flip = render_stereo(b, sr, 75.0, MODE_FULL, fixed_yaw_deg=33,
                         start_time=0.02, end_time=0.08, lr_flip=True)
    assert np.allclose(flip, a[:, [1, 0]])


def test_render_automation_matches_blockwise(sig):
    b = plane_wave(0.0, sig)
    sr = 48000
    auto = YawMarkers([(0, 0), (0.1, 90)], DIR_CCW)
    out = render_stereo(b, sr, 90.0, automation=auto)
    # 起始处 yaw≈0: 前方声像 L≈R
    assert out[0, 0] == pytest.approx(out[0, 1], rel=1e-3)
    # 渲染按 1024 样本块取块首朝向; 在块边界处与直接旋转逐样本一致
    block = 1024
    i_mid = block * 2
    t_mid = i_mid / sr                      # 0.04267s -> 期望 yaw 38.4°
    yaw_expect = 90.0 * (t_mid / 0.1)
    expect = decode_stereo(
        rotate_yaw(b[i_mid:i_mid + block], math.radians(yaw_expect)), 90.0)
    assert np.allclose(out[i_mid:i_mid + block], expect, atol=1e-12)
    # 末块朝向接近 90°: 表观方位接近 -90°, L 能量远小于 R
    last_block = out[-block:]
    assert np.mean(last_block[:, 0] ** 2) < 0.02 * np.mean(last_block[:, 1] ** 2)


def test_fuma_roundtrip(sig):
    b = plane_wave(-110.0, sig)
    fuma = np.empty_like(b)
    fuma[:, 0] = b[:, IDX_W] / math.sqrt(2.0)
    fuma[:, 1] = b[:, IDX_X] / math.sqrt(3.0)
    fuma[:, 2] = b[:, IDX_Y] / math.sqrt(3.0)
    fuma[:, 3] = b[:, IDX_Z] / math.sqrt(3.0)
    assert np.allclose(fuma_to_ambix(fuma), b, atol=1e-12)


def test_builtin_validation_all_pass():
    results = run_all_checks()
    failed = [r.name for r in results if not r.passed]
    assert not failed, failed
