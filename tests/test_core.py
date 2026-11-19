"""核心逻辑验证:环绕坐标、双向交角、保护区不变、导出回读、接缝改善。"""
import json

import numpy as np
import pytest

from seamless_tool.core import (band_mask, boundary_metrics, conflict_mask,
                                make_seamless, roll_image, tile3)
from seamless_tool.export import export_tile, load_image
from seamless_tool.textures import (corner_mismatch, diagonal_lines,
                                    gradient_grain)


@pytest.fixture
def tex():
    return gradient_grain(256, 192, seed=42)  # 非正方形,验证按自身宽高处理


# ---------- 环绕坐标 ----------

def test_roll_roundtrip_no_loss(tex):
    rolled = roll_image(tex, 100, -70)
    assert rolled.shape == tex.shape
    # 不丢内容:排序后像素集合一致
    assert np.array_equal(np.sort(rolled.reshape(-1, 3), axis=0),
                          np.sort(tex.reshape(-1, 3), axis=0))
    # 反向偏移完全还原,不补黑边
    restored = roll_image(rolled, -100, 70)
    assert np.array_equal(restored, tex)


def test_roll_coordinates(tex):
    rolled = roll_image(tex, 5, 7)
    assert np.array_equal(rolled[7, 5], tex[0, 0])
    assert np.array_equal(rolled[0, 0], tex[-7, -5])


# ---------- 接缝改善(实际指标) ----------

@pytest.mark.parametrize("gen", [gradient_grain, diagonal_lines, corner_mismatch])
def test_seam_metrics_improve(gen):
    img = gen(seed=1)
    out = make_seamless(img, None, h_on=True, h_w=24, v_on=True, v_w=24)
    b, a = boundary_metrics(img), boundary_metrics(out)
    for axis in ("h", "v"):
        # 处理后边界颜色差严格为 0(边缘两侧取同一均值)
        assert a[axis]["color_mean"] == 0.0
        assert a[axis]["color_max"] == 0.0
        # 梯度突变显著下降
        assert a[axis]["grad_mean"] < b[axis]["grad_mean"] * 0.5
        # 处理前确实有缝(指标非零),说明测试有效
        assert b[axis]["color_mean"] > 1.0


def test_disabled_axis_not_forced(tex):
    # 只开水平:垂直接缝不被处理,不强求无缝
    out = make_seamless(tex, None, h_on=True, h_w=16, v_on=False, v_w=16)
    b, a = boundary_metrics(tex), boundary_metrics(out)
    assert a["h"]["color_mean"] == 0.0
    # 垂直边界仍有残余断裂(不会被暗中处理成无缝)
    assert a["v"]["color_mean"] > 0.1
    # 过渡带之外的内部像素完全不受影响(不是整图镜像之类的全局改动)
    assert np.array_equal(out[20:-20, 20:-20], tex[20:-20, 20:-20])


# ---------- 双向交角 ----------

def test_corner_continuity_both_axes():
    img = corner_mismatch(256, 256, seed=99)
    out = make_seamless(img, None, h_on=True, h_w=32, v_on=True, v_w=32)
    # 四个角像素在双向处理后完全一致 → 2x2 平铺角点交汇连续
    corners = [out[0, 0], out[0, -1], out[-1, 0], out[-1, -1]]
    for c in corners[1:]:
        assert np.array_equal(c, corners[0])
    # 平铺后跨缝相邻像素差为 0
    t = tile3(out)
    h, w = out.shape[:2]
    assert np.array_equal(t[h - 1, w], t[h, w])      # 跨水平缝
    assert np.array_equal(t[h, w - 1], t[h, w])      # 跨垂直缝


# ---------- 保护区 ----------

def test_protected_pixels_unchanged(tex):
    rng = np.random.default_rng(0)
    mask = rng.random(tex.shape[:2]) < 0.3  # 随机 30% 保护,含过渡带
    out = make_seamless(tex, mask, h_on=True, h_w=24, v_on=True, v_w=24)
    assert np.array_equal(out[mask], tex[mask])
    # 带外未保护区域仍被处理
    assert not np.array_equal(out[~mask], tex[~mask])


def test_conflict_detection(tex):
    mask = np.zeros(tex.shape[:2], dtype=bool)
    mask[0, 10] = True          # 在水平过渡带内 → 冲突
    mask[100, 100] = True       # 内部 → 不冲突
    conf = conflict_mask(mask, h_on=True, h_w=16, v_on=False, v_w=16)
    assert conf[0, 10] and not conf[100, 100]
    assert conf.sum() == 1
    bm = band_mask(tex.shape, True, 16, False, 16)
    assert bm[:16].all() and bm[-16:].all() and not bm[16:-16].any()


# ---------- 导出回读 ----------

def test_export_roundtrip(tmp_path, tex):
    mask = np.zeros(tex.shape[:2], dtype=bool)
    mask[50:80, 60:90] = True
    out = make_seamless(tex, mask, h_on=True, h_w=20, v_on=True, v_w=20)
    params = {"offset": {"dx": 0, "dy": 0}, "source": {"kind": "test"},
              "seam": {"horizontal": {"enabled": True, "width": 20},
                       "vertical": {"enabled": True, "width": 20}}}
    files = export_tile(str(tmp_path / "tile.png"), out, mask, params)

    reloaded = load_image(files["tile"])
    assert reloaded.shape == tex.shape                      # 尺寸不变
    assert np.array_equal(reloaded, out)                    # PNG 无损
    assert np.array_equal(tile3(reloaded), tile3(out))      # 重新平铺一致
    b1, b2 = boundary_metrics(reloaded), boundary_metrics(out)
    assert b1 == b2
    # 掩码与参数可读回
    m = load_mask(files["mask"])
    assert m.shape == mask.shape and m.sum() == mask.sum()
    with open(files["params"], encoding="utf-8") as f:
        loaded = json.load(f)
    assert loaded["seam"]["horizontal"]["width"] == 20


def load_mask(path):
    import cv2
    m = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    return m > 127


# ---------- 生成纹理可复现 ----------

def test_generators_deterministic():
    a = gradient_grain(seed=5)
    b = gradient_grain(seed=5)
    c = gradient_grain(seed=6)
    assert np.array_equal(a, b)
    assert not np.array_equal(a, c)
