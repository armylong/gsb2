"""无 GUI 的功能与正确性测试，直接 `python tests/test_core.py` 运行。

覆盖：
1. overlap_mask 方向（正/负位移）与保守取整约定；
2. 残差只在有效区统计，填充区残差恒为 0；
3. 合成往返：warp 对齐后亮度校正 RMSE 应接近注入噪声水平；
4. 亚像素估计精度（纹理充分用例误差 < 0.5px）；
5. 条纹各向异性/周期歧义与低纹理场景的可信度降级。
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from alignment_tool.estimator import estimate_shift  # noqa: E402
from alignment_tool.geometry import (  # noqa: E402
    overlap_mask,
    residual_stats,
    warp_align,
)
from alignment_tool.synthetic import make_pair, make_texture  # noqa: E402

_failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f"  ({detail})" if detail else ""))
    if not cond:
        _failures.append(name)


def test_mask_direction() -> None:
    # dx>0 右移、dy<0 上移 -> 对齐图右/上侧为填充带
    m = overlap_mask((256, 320), 0.7, -0.4)
    fm = ~m
    h, w = m.shape
    check("正位移填充集中在右侧", fm[:, w // 2:].sum() > 2 * fm[:, : w // 2].sum())
    check("负dy填充集中在上侧", fm[: h // 2, :].sum() > 2 * fm[h // 2:, :].sum())
    # 反方向
    m2 = overlap_mask((256, 320), -1.6, 0.9)
    fm2 = ~m2
    check("负位移填充集中在左侧", fm2[:, : w // 2].sum() > 2 * fm2[:, w // 2:].sum())
    check("正dy填充集中在下侧", fm2[h // 2:, :].sum() > 2 * fm2[: h // 2, :].sum())
    # 零位移：全画面有效
    m0 = overlap_mask((256, 320), 0.0, 0.0)
    check("零位移无填充", m0.all())
    # 整数位移的填充像素数恰好等于位移*边长（无亚像素取整损失）
    mi = overlap_mask((100, 100), 2.0, 0.0)
    check("整数位移填充计数", (~mi).sum() == 2 * 100, f"got {(~mi).sum()}")


def test_mask_conservative() -> None:
    """掩码判为有效的像素，warp 结果必须有真实内容（不允许漏掉填充像素）。"""
    pair = make_pair(kind="blobs", dx=0.7, dy=-0.4, seed=3)
    aligned = warp_align(pair.moving, pair.dx, pair.dy)
    m = overlap_mask(pair.ref.shape[:2], pair.dx, pair.dy)
    actual_zero = aligned == 0
    # 有效区内不允许出现实际零值（掩码是零值集合的超集）
    leaked = (actual_zero & m).sum()
    check("有效区无填充泄漏", leaked == 0, f"leaked={leaked}")
    # 差异只可能是"掩码判填充但插值产生了非零值"
    diff = actual_zero != (~m)
    only_interp = (diff & ~m).sum() == diff.sum()
    check("掩码外差异均为插值污染", only_interp, f"diff pixels={diff.sum()}")


def test_residual_region() -> None:
    pair = make_pair(kind="blobs", dx=0.7, dy=-0.4, brightness=10, noise_sigma=3, seed=3)
    aligned = warp_align(pair.moving, pair.dx, pair.dy)
    st = residual_stats(pair.ref, aligned, pair.dx, pair.dy)
    check("有效+填充=总像素", st.n_valid + st.n_filled == pair.ref.size)
    check("填充区残差恒为0", st.residual[st.fill_mask].sum() == 0)
    check("亮度校正RMSE<=RMSE", st.rmse_corrected <= st.rmse + 1e-6)
    # 注入噪声 σ=3，正确对齐后校正 RMSE 应在噪声量级（留宽限到 6）
    check("校正RMSE接近噪声水平", st.rmse_corrected < 6.0,
          f"rmse_corr={st.rmse_corrected:.3f}")


def test_roundtrip_accuracy() -> None:
    cases = [
        ("blobs", 0.7, -0.4), ("dots", 2.3, 1.6),
        ("blobs", -1.8, 2.9), ("dots", 5.25, -3.75),
        ("blobs", 0.3, 0.2),
    ]
    errs = []
    for i, (kind, dx, dy) in enumerate(cases):
        base = make_texture(kind=kind, seed=10 + i)
        pair = make_pair(base=base, dx=dx, dy=dy, brightness=8, noise_sigma=3, seed=10 + i)
        est = estimate_shift(pair.ref, pair.moving)
        errs.append(np.hypot(est.dx - dx, est.dy - dy))
    worst = max(errs)
    check("纹理充分用例误差<0.5px", worst < 0.5, f"worst={worst:.3f}px mean={np.mean(errs):.3f}px")


def test_ambiguity_warnings() -> None:
    # 强方向性条纹：各向异性高、可信度不高于 medium
    p = make_pair(kind="stripes", dx=0.7, dy=0.3, noise_sigma=2, seed=5)
    e = estimate_shift(p.ref, p.moving)
    check("条纹各向异性>0.85", e.anisotropy > 0.85, f"aniso={e.anisotropy:.3f}")
    check("条纹场景降级(<=medium)", e.level in ("medium", "low"), f"level={e.level}")
    check("条纹给出孔径提示", any("孔径" in r or "方向" in r for r in e.reasons))

    # 周期位移：主候选仍定位正确，但歧义由各向异性机制兜住
    p2 = make_pair(kind="stripes", dx=14.0, dy=0.0, noise_sigma=2, seed=2)
    e2 = estimate_shift(p2.ref, p2.moving)
    check("周期位移主候选正确", abs(e2.dx - 14.0) < 0.5, f"dx={e2.dx:.3f}")

    # 低纹理：可信度不应为 high
    p3 = make_pair(kind="low_texture", dx=0.7, dy=-0.4, noise_sigma=2, seed=7)
    e3 = estimate_shift(p3.ref, p3.moving)
    check("低纹理降级(<=medium)", e3.level in ("medium", "low"),
          f"level={e3.level} texture={e3.texture_score:.3f}")

    # 正常高纹理：high
    p4 = make_pair(kind="dots", dx=1.2, dy=-0.8, noise_sigma=3, seed=8)
    e4 = estimate_shift(p4.ref, p4.moving)
    check("高纹理场景high", e4.level == "high", f"level={e4.level} conf={e4.confidence:.2f}")


def test_ecc_initialized() -> None:
    """带相位初值的 ECC 在正常纹理上应收敛并与相位结果一致。"""
    pair = make_pair(kind="dots", dx=2.3, dy=1.6, seed=11)
    e = estimate_shift(pair.ref, pair.moving)
    check("ECC可用且一致", e.ecc_available and e.ecc_agrees,
          f"ecc=({e.ecc_dx:.3f},{e.ecc_dy:.3f}) phase=({e.dx:.3f},{e.dy:.3f})")


if __name__ == "__main__":
    test_mask_direction()
    test_mask_conservative()
    test_residual_region()
    test_roundtrip_accuracy()
    test_ambiguity_warnings()
    test_ecc_initialized()
    print("\n" + ("全部通过 ✓" if not _failures else f"失败 {len(_failures)} 项: {_failures}"))
    sys.exit(1 if _failures else 0)
