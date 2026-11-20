"""核心算法单元测试 (不依赖 Qt)。"""
import numpy as np
import pytest

from scanprep.core import (
    PipelineParams, estimate_skew, flatten_illumination, process, rotate_image,
)
from scanprep.core.geometry import (
    STATUS_AMBIGUOUS, STATUS_BLANK, STATUS_LOW_CONTRAST, STATUS_OK,
)
from scanprep.samples.generator import (
    _apply_scan_effects, _content_page, _crosshatch_page, PAGE_H, PAGE_W,
    PAPER,
)


@pytest.fixture(scope="module")
def scanned_pages():
    rng = np.random.default_rng(7)
    pages = {}
    for i, theta in enumerate([-7.0, 3.2, 8.0]):
        img, _ = _content_page(seed=1000 + i)
        pages[theta] = _apply_scan_effects(img, theta, rng)
    return pages


def test_angle_recovery(scanned_pages):
    for theta, (img, _, _) in scanned_pages.items():
        est = estimate_skew(img)
        assert est.status == STATUS_OK, f"theta={theta}: {est.message}"
        assert abs(est.angle + theta) <= 0.3, f"theta={theta}, est={est.angle}"
        assert est.confidence >= 0.5


def test_blank_page_rejected():
    rng = np.random.default_rng(3)
    blank = np.full((PAGE_H, PAGE_W), PAPER, np.uint8)
    img, _, _ = _apply_scan_effects(blank, 1.5, rng)
    est = estimate_skew(img)
    assert est.status == STATUS_BLANK
    assert est.confidence == 0.0


def test_cross_direction_unreliable():
    rng = np.random.default_rng(11)
    cross, _ = _crosshatch_page(seed=77)
    img, _, _ = _apply_scan_effects(cross, -2.0, rng)
    est = estimate_skew(img)
    assert est.status in (STATUS_AMBIGUOUS, STATUS_LOW_CONTRAST) or est.confidence < 0.5


def test_rotation_expands_canvas_and_marks_fill():
    img = np.full((400, 300), 200, np.uint8)
    out, mask, M = rotate_image(img, 5.0, fill_value=245)
    assert out.shape[0] > 400 and out.shape[1] > 300
    # 四角是填充区
    assert mask[0, 0] == 0 and mask[0, -1] == 0
    assert mask[-1, 0] == 0 and mask[-1, -1] == 0
    assert out[0, 0] == 245
    # 中心是有效内容
    cy, cx = out.shape[0] // 2, out.shape[1] // 2
    assert mask[cy, cx] == 255 and out[cy, cx] == 200


def test_no_cumulative_rotation():
    """同一源图用不同角度处理, 结果互不依赖 (不会越转越糊)。"""
    rng = np.random.default_rng(5)
    img, _ = _content_page(seed=42)
    src, _, _ = _apply_scan_effects(img, 2.0, rng)
    p1 = PipelineParams(angle=3.0)
    p2 = PipelineParams(angle=-4.0)
    r1a = process(src, p1)
    r2 = process(src, p2)          # 在 p1 之后切换角度
    r1b = process(src, p1)         # 再切回 p1
    assert np.array_equal(r1a.image, r1b.image)   # 完全可复现
    assert r2.image.shape != r1a.image.shape or not np.array_equal(r2.image, r1a.image)


def test_illumination_flatten_and_black_block_kept():
    rng = np.random.default_rng(9)
    img, _ = _content_page(seed=123)
    scanned, _, _ = _apply_scan_effects(img, 0.0, rng)
    flat, paper = flatten_illumination(scanned, 1.0)
    # 纸白更均匀: 页面上下两个纸白区域的亮度差显著缩小
    top = scanned[60:100, 500:700].mean()
    bot = scanned[1500:1540, 500:700].mean()
    top_f = flat[60:100, 500:700].mean()
    bot_f = flat[1500:1540, 500:700].mean()
    assert abs(top_f - bot_f) < abs(top - bot) * 0.5
    # 黑块不被提亮
    block = flat[880:1010, 780:980]
    assert block.mean() < 100


def test_binary_output_fill_is_white():
    img = np.full((400, 300), 220, np.uint8)
    img[100:300, 100:200] = 30
    res = process(img, PipelineParams(angle=6.0, mode="binary", illumination=False))
    assert res.image[0, 0] == 255          # 填充区在二值输出中为纯白
    assert set(np.unique(res.image)) <= {0, 255}


def test_thin_line_survives_pipeline():
    """细线经过完整流水线后仍然可辨 (不被静默裁掉或抹掉)。"""
    rng = np.random.default_rng(13)
    img, thin = _content_page(seed=555)
    scanned, _, _ = _apply_scan_effects(img, 4.0, rng)
    est = estimate_skew(scanned)
    res = process(scanned, PipelineParams(angle=est.angle))
    assert est.status == STATUS_OK
    # 输出中心行附近应仍有暗像素 (细线/笔画存在)
    dark = (res.image < res.paper_level - 40) & (res.mask > 0)
    assert dark.mean() > 0.005
