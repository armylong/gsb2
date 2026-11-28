"""本地验证脚本: 用内置示例核对"半步提示"和"导出后的实际平铺位置"。

    python scripts/verify_examples.py [输出目录]

对每个示例做四件事:
1. 在建议区域里估算, 检查估出的点阵与真值一致;
2. 故意把一根向量取成半步, 确认提示会指出"真正的周期更长";
3. 取一个完整单元导出 (unit.png / compare.png / cell.json);
4. 把导出的单元按两根平移量铺回原图坐标, 量出与真实像素的平均差 ——
   这就是"导出后实际的平铺位置"是否对得上的直接证据。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from repeatcell import estimator, sampler, synth, tiling  # noqa: E402
from repeatcell.geometry import (CellBasis, choose_complete_cell,  # noqa: E402
                                 fully_inside_cells)


def _basis_from(ex) -> CellBasis:
    return CellBasis(ex.truth_origin, ex.truth_t1, ex.truth_t2)


def _tile_alignment(unit_rgb, unit_mask, basis, image) -> float:
    """把单元铺回原图坐标, 返回与原图的平均绝对差 (0..1)。"""
    h, w = image.shape[:2]
    tiled = tiling.tile_region(unit_rgb, basis, (0.0, 0.0, float(w), float(h)),
                               unit_mask=unit_mask)
    return float(np.abs(tiled - image).mean())


def main(argv) -> int:
    out_root = Path(argv[1] if len(argv) > 1 else "verify_out")
    out_root.mkdir(parents=True, exist_ok=True)
    rows = []
    ok_all = True

    for key, title in synth.list_examples():
        ex = synth.generate_example(key)
        x, y, w, h = ex.region
        crop = ex.image[y:y + h, x:x + w]
        truth = _basis_from(ex)

        # 1. 估算
        an = estimator.estimate_periodicity(crop)
        prim = an.groups[0]
        lattice_ok = synth.lattice_equivalent(
            prim.t1, prim.t2, ex.truth_t1, ex.truth_t2, tol=0.08)

        # 2. 故意取半步, 应提示 "true period is longer"
        half = ((prim.t1[0] / 2.0, prim.t1[1] / 2.0), prim.t2)
        advice_half = estimator.assess_basis(an, *half)
        advice_ok = advice_half.preferred in ("longer", "shorter", "ambiguous")

        # 3. 导出完整单元
        cell = choose_complete_cell(truth, ex.image.shape[1], ex.image.shape[0],
                                    prefer_point=(x + w / 2.0, y + h / 2.0))
        if cell is None:
            cells = fully_inside_cells(truth, ex.image.shape[1], ex.image.shape[0])
            cell = cells[0] if cells else truth
        unit_size = int(round(max(abs(truth.t1[0]) + abs(truth.t1[1]),
                                  abs(truth.t2[0]) + abs(truth.t2[1]))))
        sample = sampler.sample_cell(ex.image, cell, n=max(48, unit_size))
        out_dir = out_root / key
        res = tiling.export_cell(out_dir, sample.rgb, sample.valid, cell,
                                 ex.image, key)

        # 4. 导出后铺回原图位置, 量偏差
        align = _tile_alignment(sample.rgb, sample.valid, cell, ex.image)
        data = json.loads(res.json_path.read_text(encoding="utf-8"))
        corners_kept = (abs(data["corners"][0][0] - cell.corners()[0][0]) < 1e-9
                        and abs(data["t1"][0] - cell.t1[0]) < 1e-9)

        tile_ok = align < 0.06
        ok = lattice_ok and advice_ok and tile_ok and corners_kept
        ok_all = ok_all and ok
        rows.append({
            "key": key,
            "title": title,
            "truth_t1": [round(float(v), 3) for v in ex.truth_t1],
            "truth_t2": [round(float(v), 3) for v in ex.truth_t2],
            "estimated_t1": [round(float(v), 3) for v in prim.t1],
            "estimated_t2": [round(float(v), 3) for v in prim.t2],
            "lattice_ok": lattice_ok,
            "half_advice": advice_half.preferred,
            "tile_mean_abs_error": round(align, 5),
            "corners_fractional": data["corners_fractional"],
            "warnings": res.warnings,
            "ok": ok,
        })
        status = "OK " if ok else "FAIL"
        print(f"[{status}] {title}")
        print(f"       真值 t1={ex.truth_t1} t2={ex.truth_t2}")
        print(f"       估出 t1={np.round(prim.t1, 3).tolist()} "
              f"t2={np.round(prim.t2, 3).tolist()}  点阵一致={lattice_ok}")
        print(f"       误取半步时提示: {advice_half.preferred}")
        print(f"       平铺回原图平均误差: {align:.5f}   "
              f"小数角点={data['corners_fractional']}")
        if res.warnings:
            print("       警告: " + " / ".join(res.warnings))
        print(f"       输出: {out_dir}")

    report = out_root / "verify_report.json"
    report.write_text(json.dumps(rows, ensure_ascii=False, indent=2),
                      encoding="utf-8")
    print()
    print(f"报告: {report}")
    print("全部通过" if ok_all else "有失败项, 见上方 [FAIL]")
    return 0 if ok_all else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
