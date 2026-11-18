"""模型与插值表达式的纯逻辑测试(不需要 ffmpeg)。"""

from fractions import Fraction

import pytest

from pipeditor.model import Keyframe, Project, build_ffmpeg_expr, round_half_up


def make_project(kfs, overlay_w=320, overlay_h=240, overlay_frames=150):
    p = Project(
        canvas_w=1280,
        canvas_h=720,
        fps=Fraction(30, 1),
        frame_count=240,
        duration=8.0,
        overlay_w=overlay_w,
        overlay_h=overlay_h,
        overlay_frame_count=overlay_frames,
    )
    for f, x, y in kfs:
        p.upsert_keyframe(f, x, y)
    return p


def test_round_half_up():
    assert round_half_up(0.5) == 1
    assert round_half_up(1.4) == 1
    assert round_half_up(2.6) == 3
    assert round_half_up(469.5) == 470


def test_single_keyframe_static():
    p = make_project([(10, 100, 200)])
    for f in (0, 1, 10, 100, 239):
        assert p.position_at(f) == (100, 200)


def test_hold_before_first_and_after_last():
    p = make_project([(30, 0, 0), (60, 90, 90)])
    # 首点之前保持首点
    assert p.position_at(0) == (0, 0)
    assert p.position_at(29) == (0, 0)
    # 末点之后保持末点
    assert p.position_at(61) == (90, 90)
    assert p.position_at(239) == (90, 90)


def test_linear_interpolation_midpoint_and_rounding():
    p = make_project([(0, 40, 40), (90, 900, 440), (180, 480, 60)])
    # 端点
    assert p.position_at(0) == (40, 40)
    assert p.position_at(90) == (900, 440)
    assert p.position_at(180) == (480, 60)
    # 两点正中间
    assert p.position_at(45) == (470, 240)
    # 第 135 帧是 90->180 的中点
    assert p.position_at(135) == (690, 250)
    # 非整除位置: 40 + 860/90 = 49.555... -> 50
    assert p.position_at(1) == (50, 44)


def test_upsert_replaces_same_frame_and_keeps_sorted():
    p = make_project([(30, 10, 10), (60, 20, 20)])
    p.upsert_keyframe(45, 50, 50)
    assert [k.frame for k in p.keyframes] == [30, 45, 60]
    p.upsert_keyframe(45, 60, 60)  # 同一时刻只保留一个
    assert len(p.keyframes) == 3
    assert p.keyframe_at(45) == Keyframe(45, 60, 60)


def test_delete_keeps_at_least_one():
    p = make_project([(10, 0, 0)])
    assert p.delete_keyframe(10) is False
    p.upsert_keyframe(20, 5, 5)
    assert p.delete_keyframe(10) is True
    assert len(p.keyframes) == 1


def test_bounds_enforced():
    p = make_project([(0, 0, 0)], overlay_w=320, overlay_h=240)
    assert p.max_x == 960
    assert p.max_y == 480
    assert p.is_in_bounds(960, 480)
    assert not p.is_in_bounds(961, 0)
    with pytest.raises(ValueError):
        p.upsert_keyframe(5, 961, 0)
    assert p.clamp_position(-50, 9999) == (0, 480)


def test_overlay_visibility_window():
    p = make_project([(0, 0, 0)], overlay_frames=150)
    assert p.overlay_visible(0)
    assert p.overlay_visible(149)
    assert not p.overlay_visible(150)
    assert not p.overlay_visible(239)


def test_size_change_guard_rejects_oob_without_muting_path():
    p = make_project([(0, 900, 440)])  # 叠加 320x240 时合法
    bad = p.out_of_bounds_keyframes(400, 300)  # 新 max_x=880, max_y=420
    assert len(bad) == 1
    with pytest.raises(ValueError):
        p.apply_overlay_size(400, 300)
    # 被拒绝后原尺寸与路径原样保留
    assert p.overlay_w == 320
    assert p.keyframe_at(0).x == 900
    # 合法尺寸可应用
    p.apply_overlay_size(300, 225)
    assert p.overlay_w == 300


def test_ffmpeg_expr_single_point():
    p = make_project([(10, 123, 45)])
    assert build_ffmpeg_expr(p.keyframes, "x", p.fps) == "123"
    assert build_ffmpeg_expr(p.keyframes, "y", p.fps) == "45"


def test_ffmpeg_expr_three_points_structure():
    p = make_project([(0, 40, 40), (90, 900, 440), (180, 480, 60)])
    expr_x = build_ffmpeg_expr(p.keyframes, "x", p.fps)
    # 帧索引 = floor(t*fps+0.5), 不用 overlay 失准的 n
    assert "floor(t*30+0.5)" in expr_x
    assert expr_x.startswith("if(lt(floor(t*30+0.5),")
    # 段边界直接用整数帧号
    assert "lt(floor(t*30+0.5),90)" in expr_x
    assert "lt(floor(t*30+0.5),180)" in expr_x
    # 每段都用 floor(v+0.5) 取整, 且 1.0* 强制浮点避免整数除法截断
    # 帧号 floor 出现在每个 lt 条件和每段公式中, 共 6 处 floor
    assert expr_x.count("floor(") == 6
    assert "1.0*(900-40)" in expr_x


def test_ffmpeg_expr_matches_model_values():
    """表达式分段数值在关键帧整数帧上与模型一致。"""
    p = make_project([(0, 40, 40), (90, 900, 440), (180, 480, 60)])
    for axis in ("x", "y"):
        expr = build_ffmpeg_expr(p.keyframes, axis, p.fps)
        for kf in p.keyframes:
            vx, vy = p.position_at(kf.frame)
            expected = vx if axis == "x" else vy
            assert getattr(kf, axis) == expected
        assert "floor(t*30+0.5)" in expr


def test_ffmpeg_expr_linear_coefficients_match_python():
    """段内线性公式的系数/跨度必须与 Python 插值完全相同。"""
    p = make_project([(0, 40, 40), (90, 900, 440)])
    expr = build_ffmpeg_expr(p.keyframes, "x", p.fps)
    # 40 + 1.0*(900-40) * (N-0) / 90, floor(...+0.5)
    assert "40+1.0*(900-40)*(floor(t*30+0.5)-0)/90" in expr
    expr_y = build_ffmpeg_expr(p.keyframes, "y", p.fps)
    assert "40+1.0*(440-40)*(floor(t*30+0.5)-0)/90" in expr_y
