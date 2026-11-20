"""导出核对:重读导出文件,验证时长/帧数/音轨/带外未动/带内参考误差。"""
from __future__ import annotations

import cv2
import numpy as np

from .pipeline import probe


def _read_all(path: str) -> list[np.ndarray]:
    cap = cv2.VideoCapture(path)
    frames = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f)
    cap.release()
    return frames


def _psnr(mae_frames: list[np.ndarray]) -> float:
    mse = float(np.mean(np.concatenate([f.ravel() for f in mae_frames]) ** 2))
    if mse == 0:
        return float("inf")
    return 10 * np.log10(255.0 ** 2 / mse)


def verify(export: str, src: str, y0: int, y1: int, *,
           gt: str | None = None, tol: int = 0) -> dict:
    """返回核对结果字典;raises AssertionError 不抛,全部写进结果里。"""
    pe, ps = probe(export), probe(src)
    fe, fs = _read_all(export), _read_all(src)

    res: dict = {"export": export, "src": src, "checks": {}, "metrics": {}}
    c = res["checks"]

    c["帧数一致"] = (len(fe) == len(fs), f"{len(fe)} vs {len(fs)}")
    c["时长一致(±0.05s)"] = (abs(pe["duration"] - ps["duration"]) <= 0.05,
                          f'{pe["duration"]:.3f}s vs {ps["duration"]:.3f}s')
    if ps["has_audio"]:
        c["音轨保留"] = (pe["has_audio"], "有" if pe["has_audio"] else "无")

    # 带外逐帧比对:源与导出在 [0,y0) 和 [y1,H) 区域必须一致(无损导出时 tol=0)
    max_out = 0
    bad_frames = []
    for i, (a, b) in enumerate(zip(fe, fs)):
        d = max(int(np.abs(a[:y0].astype(np.int16) - b[:y0].astype(np.int16)).max()) if y0 > 0 else 0,
                int(np.abs(a[y1:].astype(np.int16) - b[y1:].astype(np.int16)).max()) if y1 < a.shape[0] else 0)
        max_out = max(max_out, d)
        if d > tol:
            bad_frames.append(i)
    c["带外像素未改写"] = (not bad_frames,
                      f"最大差异 {max_out}" + (f",超差帧 {bad_frames[:8]}..." if bad_frames else ""))

    # 带内参考误差:导出 vs 源(说明改动范围确实只落在带内)
    band_diffs = []
    for a, b in zip(fe, fs):
        band_diffs.append(np.abs(a[y0:y1].astype(np.int16) - b[y0:y1].astype(np.int16)))
    res["metrics"]["带内平均绝对差(导出vs源)"] = round(
        float(np.mean([d.mean() for d in band_diffs])), 3)

    if gt:
        fg = _read_all(gt)
        n = min(len(fe), len(fg))
        mae_exp, mae_src = [], []
        for i in range(n):
            mae_exp.append(np.abs(fe[i][y0:y1].astype(np.int16) - fg[i][y0:y1].astype(np.int16)).mean(axis=(1, 2)))
            mae_src.append(np.abs(fs[i][y0:y1].astype(np.int16) - fg[i][y0:y1].astype(np.int16)).mean(axis=(1, 2)))
        res["metrics"]["带内MAE·修复后vs真值"] = round(float(np.mean(mae_exp)), 3)
        res["metrics"]["带内MAE·修复前vs真值"] = round(float(np.mean(mae_src)), 3)
        res["metrics"]["带内PSNR·修复后(dB)"] = round(_psnr(mae_exp), 2)
        res["metrics"]["带内PSNR·修复前(dB)"] = round(_psnr(mae_src), 2)

    res["ok"] = all(v[0] for v in c.values())
    return res


def format_report(res: dict) -> str:
    lines = [f"核对: {res['export']}"]
    for name, (ok, detail) in res["checks"].items():
        lines.append(f"  [{'PASS' if ok else 'FAIL'}] {name} — {detail}")
    for name, v in res["metrics"].items():
        lines.append(f"  [指标] {name}: {v}")
    lines.append("结论: " + ("全部通过 ✔" if res["ok"] else "存在未通过项 ✘"))
    return "\n".join(lines)
