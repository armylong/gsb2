"""命令行验证：一条命令跑通“自动成功 + 应拒绝”两类样例并给出量化指标。

用法：
    python -m panorama.cli verify --out output/verify
    python -m panorama.cli gui
    python -m panorama.cli generate --out output/scene [--loop]
    python -m panorama.cli stitch img1.png img2.png ... --out output/pano
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

from . import blend, geometry as geo
from .config import Config
from .engine import PanoramaEngine
from .synthetic import build_synthetic_scene


def _truth_corner_errors(eng, rep, meta):
    truth = {f["file"]: np.array(f["H_to_world"]) for f in meta["frames"]}
    H0 = truth[eng.photos[0].name]
    out = {}
    for p in eng.photos:
        if p.pid not in rep.layout.globals_H:
            continue
        H_est = rep.layout.globals_H[p.pid]
        H_true = geo.compose(truth[p.name], geo.invert(H0))
        corners = geo.image_corners(*p.size)
        err = np.linalg.norm(
            geo.warp_points(H_est, corners)
            - geo.warp_points(H_true, corners),
            axis=1,
        ).mean()
        out[p.name] = float(err)
    return out


def _verify_success_case(out: Path) -> dict:
    """样例 A：5 帧同平面场景 + 1 张不相干图，应自动成功并排除不相干图。"""
    scene = out / "success_scene"
    meta = build_synthetic_scene(scene, n_frames=5)
    eng = PanoramaEngine(Config())
    for f in meta["frames"]:
        eng.add_photo(str(scene / f["file"]))
    unrelated_pid = eng.add_photo(str(scene / meta["unrelated"])).pid
    rep = eng.rebuild()

    result = {
        "case": "A_自动成功_含不相干图",
        "build_ok": rep.ok,
        "unrelated_excluded": unrelated_pid in rep.excluded,
        "excluded_pids": rep.excluded,
        "global_rmse_px": round(rep.layout.global_rmse, 3),
        "has_loop": rep.layout.has_loop,
        "corner_errors_px": {
            k: round(v, 2) for k, v in _truth_corner_errors(eng, rep, meta).items()
        },
    }
    result["max_corner_error_px"] = round(max(result["corner_errors_px"].values()), 2)

    full = blend.export_full_canvas(rep.canvas, eng.cfg)
    crop, rect = blend.export_valid_crop(rep.canvas, eng.cfg)
    cv2.imwrite(str(out / "A_full_canvas.png"), full)
    cv2.imwrite(str(out / "A_valid_crop.png"), crop)
    result["full_canvas"] = str(out / "A_full_canvas.png")
    result["valid_crop"] = str(out / "A_valid_crop.png")
    result["crop_has_holes"] = bool((crop[..., 3] == 0).sum() > 0)
    result["black_pixels_preserved"] = int(
        np.sum((crop[..., :3].sum(axis=2) == 0) & (crop[..., 3] == 255))
    )
    result["ghost_fraction"] = round(rep.canvas.ghost_frac, 4)

    # 配对诊断
    result["pairs"] = [
        {
            "pair": list(k),
            "accepted": m.accepted,
            "raw_matches": m.n_raw,
            "inliers": m.n_inliers,
            "inlier_ratio": round(m.inlier_ratio, 3),
            "rmse_px": round(m.rmse, 2) if np.isfinite(m.rmse) else None,
            "confidence": round(m.confidence, 3),
            "reasons": m.reasons,
        }
        for k, m in rep.pair_matches.items()
    ]
    return result


def _verify_reject_case(out: Path) -> dict:
    """样例 B：错误控制点 + 低纹理，验证拒绝与回退，绝不导出无依据全景。"""
    scene = out / "reject_scene"
    meta = build_synthetic_scene(scene, n_frames=4)
    cfg = Config()
    eng = PanoramaEngine(cfg)
    for f in meta["frames"]:
        eng.add_photo(str(scene / f["file"]))
    good = eng.rebuild()
    assert good.ok

    # 注入一组矛盾控制点（前两个点故意偏移 90px）
    pair = next(iter(meta["control_points_wrong"]))
    fa, fb = pair.split("|")
    pid_a = next(p.pid for p in eng.photos if p.name == fa)
    pid_b = next(p.pid for p in eng.photos if p.name == fb)
    wrong = meta["control_points_wrong"][pair]
    for s, d in zip(wrong["src"], wrong["dst"]):
        eng.add_control_point(pid_a, pid_b, s, d)
    manual = eng.controls.solve_manual(
        pid_a, pid_b,
        eng.photos[0].image.shape[:2], eng.photos[1].image.shape[:2], cfg,
    )

    # 控制点不足场景
    store_eng = PanoramaEngine(cfg)
    for f in meta["frames"][:2]:
        store_eng.add_photo(str(scene / f["file"]))
    true = meta["control_points_true"][pair]
    store_eng.add_control_point(0, 1, true["src"][0], true["dst"][0])
    store_eng.add_control_point(0, 1, true["src"][1], true["dst"][1])
    insufficient = store_eng.controls.solve_manual(
        0, 1, (520, 640), (520, 640), cfg
    )

    # 失控变换护栏
    H_extreme = np.diag([20.0, 20.0, 1.0])
    sanity = geo.check_homography_sanity(H_extreme, 640, 520, cfg)

    return {
        "case": "B_应拒绝_错误控制点与退化变换",
        "contradictory_cp_rejected": not manual.ok,
        "contradictory_reasons": manual.reasons,
        "insufficient_cp_rejected": not insufficient.ok,
        "insufficient_reasons": insufficient.reasons,
        "extreme_transform_rejected": not sanity.ok,
        "extreme_reasons": sanity.reasons,
        "last_good_available_after_failure": eng.has_last_good(),
    }


def _verify_loop_case(out: Path) -> dict:
    """样例 C：首尾重叠闭环，验证闭环检测与全局一致性。"""
    scene = out / "loop_scene"
    meta = build_synthetic_scene(scene, n_frames=5, closed_loop=True)
    eng = PanoramaEngine(Config())
    for f in meta["frames"]:
        eng.add_photo(str(scene / f["file"]))
    rep = eng.rebuild()
    return {
        "case": "C_首尾闭环",
        "build_ok": rep.ok,
        "loop_detected": rep.layout.has_loop,
        "loop_closure_gain_px": round(rep.layout.loop_closure_gain, 3),
        "chain_vs_global_drift_px": round(rep.layout.max_corner_drift_px, 2),
        "global_rmse_px": round(rep.layout.global_rmse, 3),
        "max_edge_rmse_px": round(max(rep.layout.edge_rmse_after.values()), 3),
    }


def cmd_verify(args) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    results = [
        _verify_success_case(out),
        _verify_reject_case(out),
        _verify_loop_case(out),
    ]
    report_path = out / "verify_report.json"
    with open(report_path, "w", encoding="utf-8") as fp:
        json.dump(results, fp, ensure_ascii=False, indent=2)

    ok = True
    for r in results:
        print(f"\n=== {r['case']} ===")
        for k, v in r.items():
            if k == "case":
                continue
            print(f"  {k}: {v}")

    a, b, c = results
    ok &= a["build_ok"] and a["unrelated_excluded"]
    ok &= a["max_corner_error_px"] < 40.0
    ok &= not a["crop_has_holes"] and a["black_pixels_preserved"] > 0
    ok &= b["contradictory_cp_rejected"] and b["insufficient_cp_rejected"]
    ok &= b["extreme_transform_rejected"] and b["last_good_available_after_failure"]
    ok &= c["build_ok"] and c["loop_detected"] and c["max_edge_rmse_px"] < 3.0

    print("\n" + ("✅ 全部验证通过" if ok else "❌ 存在失败项"))
    print(f"详细报告：{report_path}")
    return 0 if ok else 1


def cmd_generate(args) -> int:
    out = Path(args.out)
    meta = build_synthetic_scene(out, n_frames=args.frames, closed_loop=args.loop)
    print(f"已生成 {args.frames} 帧场景到 {out}")
    print(f"真值文件：{out / 'groundtruth.json'}")
    print(f"不相干图片：{out / meta['unrelated']}")
    return 0


def cmd_stitch(args) -> int:
    eng = PanoramaEngine(Config())
    for p in args.images:
        eng.add_photo(p)
    rep = eng.rebuild()
    if not rep.ok:
        print("拼接失败：", file=sys.stderr)
        for r in rep.reasons:
            print("  -", r, file=sys.stderr)
        if rep.rolled_back:
            print("已回退到上次有效结果", file=sys.stderr)
        return 2
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if args.crop:
        img, rect = blend.export_valid_crop(rep.canvas, eng.cfg)
        print(f"有效裁剪矩形 x,y,w,h = {rect}")
    else:
        img = blend.export_full_canvas(rep.canvas, eng.cfg)
    cv2.imwrite(str(out), img)
    print(f"已导出：{out}")
    if rep.excluded:
        print(f"已排除无可信重叠照片 pid={rep.excluded}")
    return 0


def cmd_gui(_args) -> int:
    from .app import main
    return main()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="平面/远景全景拼接工具")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_verify = sub.add_parser("verify", help="运行自动成功+应拒绝验证样例")
    p_verify.add_argument("--out", default="output/verify")
    p_verify.set_defaults(func=cmd_verify)

    p_gen = sub.add_parser("generate", help="生成带真值的合成测试场景")
    p_gen.add_argument("--out", required=True)
    p_gen.add_argument("--frames", type=int, default=5)
    p_gen.add_argument("--loop", action="store_true")
    p_gen.set_defaults(func=cmd_generate)

    p_stitch = sub.add_parser("stitch", help="拼接指定图片")
    p_stitch.add_argument("images", nargs="+")
    p_stitch.add_argument("--out", required=True)
    p_stitch.add_argument("--crop", action="store_true")
    p_stitch.set_defaults(func=cmd_stitch)

    p_gui = sub.add_parser("gui", help="启动图形界面")
    p_gui.set_defaults(func=cmd_gui)
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
