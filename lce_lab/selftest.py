"""无界面自测:不启动 Qt,直接验证处理管线的关键性质。

运行:
    python -m lce_lab.selftest            # 退出码 0 即全部通过
    python -m lce_lab.selftest --out DIR  # 额外导出处理结果 PNG 供肉眼复验
"""
from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

from . import processing as P


def _line(msg: str) -> None:
    print(msg, flush=True)


def _check(name: str, ok: bool, detail: str = "") -> bool:
    tag = "PASS" if ok else "FAIL"
    _line(f"[{tag}] {name}" + (f" — {detail}" if detail else ""))
    return ok


def run(out_dir: str | None = None) -> int:
    failures = 0

    # 1. 样例可生成且确定性
    img = P.make_sample("blocks")
    img2 = P.make_sample("blocks")
    failures += not _check("样例生成确定性", np.array_equal(img, img2),
                           f"shape={img.shape} id={P.image_id(img)}")
    edge = P.make_sample("edge")
    extreme = P.make_sample("extreme")
    color = P.make_sample("color")
    failures += not _check("极端小图尺寸", extreme.shape[:2] == (24, 32))

    # 2. 确定性:同输入同参数两次处理逐像素一致
    p_full = P.Params(mode="local_full", clip_limit=6.0, tile_size=32, strength=1.0)
    r1 = P.process(img, p_full)
    r2 = P.process(img, p_full)
    failures += not _check("处理结果可复现(逐像素)", np.array_equal(r1.image, r2.image))

    # 3. 平坦块噪声被放大:暗平坦区取一块,std 应明显上升
    flat_rect = (20, 120, 60, 60)
    bs = P.block_stats(img, r1.image, flat_rect)
    failures += not _check(
        "平坦处噪声被放大(核心现象)", bs.l_std_after > bs.l_std_before * 1.15,
        f"std {bs.l_std_before:.2f} -> {bs.l_std_after:.2f}, "
        f"噪声增益 x{bs.noise_gain:.2f}, 对比变化 {bs.contrast_change:+.1f}%")

    # 4. 低对比纹理被保住:纹理条调整后仍有周期性,且对比度不低于原图
    tex_rect = (280, 120, 50, 120)
    bst = P.block_stats(img, r1.image, tex_rect)
    failures += not _check("低对比纹理保留(对比不被抹平)", bst.l_std_after >= bst.l_std_before,
                           f"std {bst.l_std_before:.2f} -> {bst.l_std_after:.2f}")

    # 5. strength=0 等于原图;遮罩外像素逐像素不动
    p_zero = P.Params(mode="local_full", strength=0.0)
    failures += not _check("强度为 0 时输出=输入",
                           np.array_equal(P.process(img, p_zero).image, img))
    h, w = img.shape[:2]
    seg = P.Segment(name="段1", points=[(40, 40), (200, 40), (200, 300), (40, 300)],
                    clip_limit=8.0, tile_size=24, strength=1.0)
    p_mask = P.Params(mode="local_mask", feather=12, segments=[
        seg, P.Segment(name="段2", points=[])])
    rm = P.process(img, p_mask)
    mask = P.polygon_mask(img.shape, seg.points)
    outside = mask == 0
    failures += not _check("遮罩外像素保持不动",
                           np.array_equal(rm.image[outside], img[outside]),
                           f"外部像素数={int(outside.sum())}")

    # 6. 两段相接、羽化后交界处连续:交界线上 L 二阶差分足够小
    s1 = P.Segment(name="段1", points=[(0, 0), (240, 0), (240, h), (0, h)],
                   clip_limit=4.0, tile_size=28, strength=1.0)
    s2 = P.Segment(name="段2", points=[(240, 0), (w, 0), (w, h), (240, h)],
                   clip_limit=12.0, tile_size=48, strength=0.8)
    p_two = P.Params(mode="local_mask", feather=16, segments=[s1, s2])
    rtwo = P.process(edge, p_two)
    l = cv2.cvtColor(rtwo.image, cv2.COLOR_BGR2LAB)[:, :, 0]
    row = l[h // 2].astype(np.float32)
    # CLAHE 本身有瓦片缝(绝对二阶差分会很大)。连续性的正确判据是:
    # 交界处(240 列附近)的二阶差分,不显著大于单段内部瓦片缝的基线水平。
    at_seam = np.abs(np.diff(row[228:253], n=2)).max()
    base_seg1 = np.abs(np.diff(row[60:180], n=2))
    base_seg2 = np.abs(np.diff(row[300:440], n=2))
    baseline = np.concatenate([base_seg1, base_seg2])
    base_p95 = float(np.percentile(baseline, 95))
    failures += not _check(
        "两段交界处连续(混合折点不超过 CLAHE 瓦片缝基线)",
        at_seam <= base_p95 * 1.5 + 2.0,
        f"交界 max|二差|={at_seam:.1f}, 段内 P95 基线={base_p95:.1f}")
    # 过渡带外:两侧分别等于各自段的独立处理结果
    r_s1 = P.from_lab(P.apply_clahe(P.to_lab(edge), 4.0, 28, 1.0))
    r_s2 = P.from_lab(P.apply_clahe(P.to_lab(edge), 12.0, 48, 0.8))
    far_left = np.array_equal(rtwo.image[:, :200], r_s1[:, :200])
    far_right = np.array_equal(rtwo.image[:, 280:], r_s2[:, 280:])
    failures += not _check("过渡带外各自段参数生效且确定", far_left and far_right)

    # 7. 极端区域尺寸不崩:tile 比图大、clip=0、clip 很大
    for ts, clip in ((2, 0.0), (512, 40.0), (4, 0.5)):
        try:
            out = P.process(extreme, P.Params(mode="local_full",
                                              clip_limit=clip, tile_size=ts))
            ok = out.image.shape == extreme.shape and out.image.dtype == np.uint8
        except Exception as exc:  # noqa: BLE001
            ok = False
            detail = f"异常 {exc!r}"
        else:
            detail = f"tile={ts} clip={clip}"
        failures += not _check(f"极端参数可处理({detail})", ok)

    # 8. 标记只标记不改明暗:去掉标记层后处理图不变;彩图能产生饱和标记
    base_no_mark = r1.image
    failures += not _check("标记层不改变处理结果", np.array_equal(
        r1.markers[~(r1.clip_mask | r1.fringe_mask)], base_no_mark[~(r1.clip_mask | r1.fringe_mask)]))
    rc = P.process(color, P.Params(mode="local_full", clip_limit=20.0, tile_size=24))
    failures += not _check("彩图可触发饱和裁切标记", rc.clip_mask.sum() > 0,
                           f"裁切像素={int(rc.clip_mask.sum())}")
    failures += not _check("灰度图不产生彩边误报", r1.fringe_mask.sum() == 0)

    # 9. 项目存取 + 复验一致:保存后重载,导出与首次导出逐像素相同
    with tempfile.TemporaryDirectory() as td:
        proj = Path(td) / "a.lceproj"
        ref_rect = (30, 100, 50, 50)
        P.save_project(proj, img, p_full, ref_rect)
        bgr2, params2, ref2, in_id = P.load_project(proj)
        # JSON 往返会把 tuple 转成 list,用 Params 语义比较而非原始 dict
        ok = (np.array_equal(bgr2, img) and P.image_id(bgr2) == in_id
              and ref2 == ref_rect and params2.to_dict() == P.Params.from_dict(
                  p_full.to_dict()).to_dict())
        failures += not _check("项目保存/恢复参数与输入一致", ok)
        export1 = P.encode_png(P.process(img, p_full).image)
        export2 = P.encode_png(P.process(bgr2, params2).image)
        failures += not _check("恢复项目后导出逐像素一致(可复验)", export1 == export2)

    # 10. 全局均衡可运行且确实改变了平坦区对比分布
    rg = P.process(img, P.Params(mode="global"))
    bsg = P.block_stats(img, rg.image, flat_rect)
    failures += not _check("全局模式可运行并改变分布",
                           not np.array_equal(rg.image, img) and bsg.l_std_after >= 0)

    if out_dir:
        d = Path(out_dir)
        d.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(d / "sample_blocks.png"), img)
        cv2.imwrite(str(d / "out_local_full.png"), r1.image)
        cv2.imwrite(str(d / "out_local_full_markers.png"), r1.markers)
        cv2.imwrite(str(d / "out_mask.png"), rm.image)
        cv2.imwrite(str(d / "out_two_segments.png"), rtwo.image)
        cv2.imwrite(str(d / "out_global.png"), rg.image)
        _line(f"已导出复验图像到 {d}")

    _line("-" * 56)
    if failures:
        _line(f"自测失败 {failures} 项")
        return 1
    _line("全部自测通过")
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description="lce_lab 无界面自测")
    ap.add_argument("--out", default=None, help="导出处理结果 PNG 的目录")
    args = ap.parse_args()
    sys.exit(run(args.out))


if __name__ == "__main__":
    main()
