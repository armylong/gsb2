"""无界面验证: 生成样例 -> 两种方法修补 -> 导出图片 -> 报告遮罩内误差.

用法:
    python -m scratchfix.verify [--out out_verify] [--seed 7]

校验项 (任一失败则以非零码退出):
  1. 两种方法修补后, 遮罩外像素与损伤图逐位一致;
  2. 会话撤销语义: 提交两块 -> 撤销一次 -> 结果回到第一次提交后的状态;
     且遮罩的改动只影响未提交预览, 不影响已提交结果;
  3. 修补误差有限且在宽松阈值内 (RMSE < 60).
报告项:
  * 整遮罩 MAE/RMSE, 以及"细线 x 损伤"交叉区误差 (结构是否接上).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np

from .synth import generate_sample
from .inpaint import inpaint
from .metrics import mask_errors, outside_unchanged, line_continuity
from .session import RepairSession


def _save(path: Path, img: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if img.ndim == 2:
        cv2.imwrite(str(path), img)
    else:
        cv2.imwrite(str(path), cv2.cvtColor(img, cv2.COLOR_RGB2BGR))


def _fmt(e: dict) -> str:
    return f"MAE={e['mae']:6.2f}  RMSE={e['rmse']:6.2f}  MAX={e.get('max', 0):6.1f}  ({e['pixels']} px)"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m scratchfix.verify")
    ap.add_argument("--out", default="out_verify", help="导出目录")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    failures: list[str] = []

    # ---------- 1. 生成样例 ----------
    s = generate_sample(seed=args.seed)
    clean, damaged, mask, line_mask = s["clean"], s["damaged"], s["mask"], s["line_mask"]
    _save(out / "01_clean.png", clean)
    _save(out / "02_damaged.png", damaged)
    _save(out / "03_mask.png", mask)
    print(f"[样例] seed={args.seed} 尺寸={clean.shape[1]}x{clean.shape[0]} "
          f"损伤像素={int((mask > 0).sum())}")

    # ---------- 2. 两种方法整图修补 + 选区外不变性 ----------
    results = {}
    for method in ("diffusion", "texture"):
        r = inpaint(damaged, mask, method)
        results[method] = r
        ok, changed = outside_unchanged(damaged, r, mask)
        status = "OK" if ok else f"FAIL ({changed} px 被改动)"
        print(f"[选区外不变] {method:9s}: {status}")
        if not ok:
            failures.append(f"{method}: 遮罩外 {changed} 像素被改动")
        _save(out / f"04_repaired_{method}.png", r)

    # ---------- 3. 遮罩内误差 + 细线结构 ----------
    print("\n[遮罩内误差 vs 干净原图]")
    for method, r in results.items():
        e = mask_errors(r, clean, mask)
        lc = line_continuity(r, clean, line_mask, mask)
        print(f"  {method:9s} 整遮罩: {_fmt(e)}")
        print(f"  {method:9s} 细线交叉区: MAE={lc['mae']:6.2f}  RMSE={lc['rmse']:6.2f}"
              f"  ({lc['pixels']} px)")
        if e["rmse"] >= 60:
            failures.append(f"{method}: RMSE={e['rmse']:.1f} 超过阈值 60")

    # 差异热力图 (遮罩内误差越大越亮)
    for method, r in results.items():
        diff = np.abs(r.astype(np.int16) - clean.astype(np.int16)).max(axis=-1)
        heat = np.zeros(diff.shape, np.uint8)
        heat[mask > 0] = np.clip(diff[mask > 0] * 4, 0, 255).astype(np.uint8)
        _save(out / f"05_errormap_{method}.png", heat)

    # ---------- 4. 会话: 撤销语义 + 遮罩只影响未提交结果 ----------
    print("\n[会话语义]")
    ses = RepairSession(damaged)
    # 把遮罩切成上下两块, 模拟逐块修补
    h = mask.shape[0]
    m1 = mask.copy(); m1[h // 2:, :] = 0
    m2 = mask.copy(); m2[:h // 2, :] = 0

    ses.commit(m1, "diffusion")
    after_first = ses.result.copy()
    ses.commit(m2, "texture")
    after_second = ses.result.copy()

    # 4a. 撤销一步应回到第一次提交后
    if ses.undo() and np.array_equal(ses.result, after_first):
        print("  撤销一步回到上一提交状态: OK")
    else:
        failures.append("撤销后结果不等于第一次提交状态")
        print("  撤销一步回到上一提交状态: FAIL")

    # 4b. 遮罩改动只影响预览, 不影响已提交结果
    committed_before = ses.result.copy()
    m_edit = m2.copy()
    m_edit[:10, :10] = 255  # 额外涂一块
    _ = ses.preview(m_edit, "diffusion")
    if np.array_equal(ses.result, committed_before):
        print("  修改遮罩不影响已提交结果: OK")
    else:
        failures.append("preview 改变了已提交结果")
        print("  修改遮罩不影响已提交结果: FAIL")

    # 4c. 撤销到空后回到原图
    while ses.undo():
        pass
    if np.array_equal(ses.result, damaged):
        print("  全部撤销后回到损伤原图: OK")
    else:
        failures.append("全部撤销后未回到损伤原图")
        print("  全部撤销后回到损伤原图: FAIL")

    # 导出一张"逐块提交"的最终结果示例
    ses2 = RepairSession(damaged)
    ses2.commit(m1, "diffusion")
    ses2.commit(m2, "texture")
    _save(out / "06_repaired_blockwise.png", ses2.result)

    # ---------- 汇总 ----------
    print(f"\n[导出] {out.resolve()}")
    for p in sorted(out.glob("*.png")):
        print(f"  {p.name}")
    if failures:
        print("\n验证失败:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\n全部校验通过 ✔")
    return 0


if __name__ == "__main__":
    sys.exit(main())
