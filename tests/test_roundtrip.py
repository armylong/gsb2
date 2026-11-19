"""真实 JPEG 回读验证:实际编码解码后核对尺寸、字节数与选区数据。

不要求任何编码器的文件大小固定不变,只核对内部一致性。
"""

import json
import os

import numpy as np
import pytest

from jpeg_analyzer import codec, metrics, sample_image


@pytest.fixture(scope="module")
def ref():
    return sample_image.generate()


def test_roundtrip_size_and_bytes(ref):
    """解码宽高必须等于参考,字节数必须等于实际编码输出长度。"""
    for sub in codec.SUBSAMPLING:
        res = codec.run_round(ref, 90, sub)
        assert (res.width, res.height) == (ref.shape[1], ref.shape[0])
        assert res.nbytes == len(res.jpeg_bytes)
        assert res.nbytes > 0
        # 回读同一份字节流, 得到同样的像素
        again = codec.decode_jpeg(res.jpeg_bytes)
        assert np.array_equal(again, res.decoded)


def test_decoded_is_valid_8bit(ref):
    res = codec.run_round(ref, 85, "4:2:0 (四分之一色度)")
    assert res.decoded.dtype == np.uint8
    assert res.decoded.shape == ref.shape


def test_roi_stats_match_direct_computation(ref):
    """选区统计必须与直接在解码数组上切片计算一致。"""
    res = codec.run_round(ref, 75, "4:4:4 (全色度)")
    rect = (10, 10, 100, 50)
    s = metrics.region_stats(ref, res.decoded, rect)
    x, y, w, h = rect
    d = metrics.abs_diff(ref[y:y + h, x:x + w], res.decoded[y:y + h, x:x + w])
    assert s["mae"] == pytest.approx(float(d.mean()))
    assert s["pixels"] == w * h


def test_grid_weighting_on_real_jpeg(ref):
    """真实 JPEG 解码结果上, 网格加权 MAE 与全图 MAE 一致。"""
    res = codec.run_round(ref, 60, "4:2:0 (四分之一色度)")
    blocks = metrics.grid_stats(ref, res.decoded, 64)
    full = metrics.region_stats(ref, res.decoded)
    assert metrics.weighted_mae(blocks) == pytest.approx(full["mae"], abs=1e-12)
    assert sum(b["pixels"] for b in blocks) == ref.shape[0] * ref.shape[1]


def test_high_quality_full_chroma_small_error(ref):
    """q=100 + 4:4:4 误差应明显小于 q=20 + 4:2:0(方向性检查, 不钉死数值)。"""
    good = codec.run_round(ref, 100, "4:4:4 (全色度)")
    bad = codec.run_round(ref, 20, "4:2:0 (四分之一色度)")
    mae_good = metrics.region_stats(ref, good.decoded)["mae"]
    mae_bad = metrics.region_stats(ref, bad.decoded)["mae"]
    assert mae_good < mae_bad


def test_roi_json_roundtrip(tmp_path):
    """选区 JSON 写出再读回, 坐标与设置不丢失。"""
    meta = {
        "reference": {"name": "内置对照图", "width": 640, "height": 400},
        "settings": {"A": {"quality": 90, "subsampling": "4:4:4 (全色度)"},
                     "B": {"quality": 70, "subsampling": "4:2:0 (四分之一色度)"}},
        "rois": [{"name": "选区1", "x": 3, "y": 5, "w": 100, "h": 60}],
        "markers": [{"type": "块边界", "x": 8, "y": 8}],
    }
    p = tmp_path / "rois.json"
    p.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    back = json.loads(p.read_text(encoding="utf-8"))
    assert back["rois"][0]["x"] == 3 and back["rois"][0]["w"] == 100
    assert back["settings"]["B"]["quality"] == 70
    assert back["markers"][0]["type"] == "块边界"


def test_reference_png_validation(tmp_path):
    """不透明 PNG 通过; 半透明或超大被拒。"""
    from PIL import Image
    ok = Image.fromarray(sample_image.generate(64, 48), "RGB")
    p_ok = tmp_path / "ok.png"
    ok.save(p_ok)
    arr = codec.load_reference_png(str(p_ok))
    assert arr.shape == (48, 64, 3)

    rgba = np.dstack([np.zeros((10, 10, 3), np.uint8),
                      np.full((10, 10), 128, np.uint8)])
    p_alpha = tmp_path / "alpha.png"
    Image.fromarray(rgba, "RGBA").save(p_alpha)
    with pytest.raises(ValueError, match="不透明"):
        codec.load_reference_png(str(p_alpha))

    big = Image.fromarray(np.zeros((10, 1601, 3), np.uint8), "RGB")
    p_big = tmp_path / "big.png"
    big.save(p_big)
    with pytest.raises(ValueError, match="1600"):
        codec.load_reference_png(str(p_big))
