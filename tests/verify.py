"""关键行为验证:正常跟随、失跟提示、人工修正、真实导出帧。

运行(仓库根目录): .venv/bin/python -m tests.verify
覆盖:
 1. 样例生成与格式(帧数/帧率/分辨率/音频/真值文件)
 2. 正常平移+缩放段的跟踪精度(与真值 IoU)
 3. 短暂遮挡段必须报低置信(不得把旧框当可靠结果)
 4. 人工修正:生效于后续区间、保留其他关键帧、访问顺序无关
 5. 导出:帧数/时长/音频保持,首帧/末帧/修正附近帧的遮挡像素核对
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import sample_gen, video_io  # noqa: E402
from app.tracker import MaskTrack  # noqa: E402

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLES = os.path.join(BASE, "samples")
EXPORTS = os.path.join(BASE, "exports")

FAILURES = []


def check(name, cond, detail=""):
    tag = "PASS" if cond else "FAIL"
    print(f"[{tag}] {name}" + (f"  {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


def iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x0, y0 = max(ax, bx), max(ay, by)
    x1, y1 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    union = aw * ah + bw * bh - inter
    return inter / union if union else 0.0


def main():
    os.makedirs(EXPORTS, exist_ok=True)

    # ---- 1. 样例生成与格式 ----
    paths = sample_gen.generate(SAMPLES)
    info = video_io.probe(paths["video"])
    check("样例格式合规", info["ok"], str(info["errors"]))
    check("样例帧数/帧率/分辨率", info["frames"] == 180 and abs(info["fps"] - 30) < 1e-6
          and info["width"] == 1280 and info["height"] == 720)
    check("样例含音频", info["has_audio"])
    with open(paths["ground_truth"]) as f:
        gt = json.load(f)["per_frame"]
    check("真值帧数与视频一致", len(gt) == info["frames"])

    # 跟踪器从视频画面取帧(不读真值)
    cap = cv2.VideoCapture(paths["video"])
    frames = []
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        frames.append(cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY))
    cap.release()
    get_gray = lambda i: frames[i]  # noqa: E731

    # ---- 2. 正常跟随(平移+缩放) ----
    g0 = gt[0]
    mt = MaskTrack(get_gray, info["frames"])
    mt.set_region(0, 179, 0, (g0["x"], g0["y"], g0["w"], g0["h"]))
    mt.compute()
    vis_iou, vis_ok_conf = [], 0
    for f in list(range(1, 90)) + list(range(120, 180)):
        g = gt[f]
        if not g["visible"]:
            continue
        r = mt.results[f]
        vis_iou.append(iou((r["x"], r["y"], r["w"], r["h"]),
                           (g["x"], g["y"], g["w"], g["h"])))
        if r["level"] in ("high", "medium"):
            vis_ok_conf += 1
    mean_iou = float(np.mean(vis_iou))
    check("可见段平均 IoU > 0.6", mean_iou > 0.6, f"mean IoU={mean_iou:.3f}")
    check("可见段 ≥90% 非低置信", vis_ok_conf / len(vis_iou) >= 0.9,
          f"{vis_ok_conf}/{len(vis_iou)}")

    # ---- 3. 遮挡段报低置信 ----
    occ_low = sum(1 for f in range(95, 116) if mt.results[f]["level"] == "low")
    check("遮挡段 ≥80% 低置信", occ_low >= 0.8 * 21, f"{occ_low}/21")
    lows = mt.low_intervals()
    check("存在覆盖遮挡区的待检查区间",
          any(a <= 100 <= b for a, b in lows), str(lows))

    # ---- 4. 人工修正 ----
    before = {f: dict(mt.results[f]) for f in (60, 150, 160, 170)}
    r150 = mt.results[150]
    corr = (r150["x"] + 30, r150["y"] + 10, r150["w"], r150["h"])
    mt.add_keyframe(150, corr)
    mt.compute()
    k150 = mt.results[150]
    check("修正帧框与修正一致",
          abs(k150["x"] - corr[0]) < 0.6 and abs(k150["y"] - corr[1]) < 0.6)
    check("修正影响后续区间",
          abs(mt.results[170]["x"] - before[170]["x"]) > 5)
    check("修正不影响之前区间",
          abs(mt.results[60]["x"] - before[60]["x"]) < 1e-6)
    check("初始关键帧保留", 0 in mt.keyframes and 150 in mt.keyframes)
    # 访问顺序无关: 新实例重算,逐帧结果一致
    mt2 = MaskTrack(get_gray, info["frames"])
    mt2.keyframes = dict(mt.keyframes)
    mt2.start, mt2.end = mt.start, mt.end
    mt2.compute()
    same = all(abs(mt.results[f]["x"] - mt2.results[f]["x"]) < 1e-9
               for f in range(0, 180))
    check("重算结果确定(与访问顺序无关)", same)
    # 删除修正后回到原结果
    mt.remove_keyframe(150)
    mt.compute()
    check("删除修正后恢复原跟踪",
          abs(mt.results[170]["x"] - before[170]["x"]) < 1e-6)

    # ---- 5. 导出与真实帧核对 ----
    mt.add_keyframe(150, corr)
    mt.compute()
    out = os.path.join(EXPORTS, "verify_masked.mp4")
    boxes = {f: (r["x"], r["y"], r["w"], r["h"]) for f, r in mt.results.items()}
    res = video_io.export_masked(paths["video"], boxes, (0, 179), out, info["fps_str"])
    oinfo = video_io.probe(out)
    check("导出帧数一致", oinfo["frames"] == info["frames"],
          f'{oinfo["frames"]} vs {info["frames"]}')
    check("导出时长一致", abs(oinfo["duration"] - info["duration"]) < 0.05,
          f'{oinfo["duration"]} vs {info["duration"]}')
    check("导出保留音频", oinfo["has_audio"])
    check("导出帧数与写入数一致", res["frames"] == info["frames"])

    def frame_at(path, idx):
        c = cv2.VideoCapture(path)
        c.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, fr = c.read()
        c.release()
        assert ok, f"读不到第 {idx} 帧"
        return fr

    def rect_is_black(img, box):
        x, y, w, h = [int(round(v)) for v in box]
        pad = 4
        roi = img[y + pad:y + h - pad, x + pad:x + w - pad]
        return roi.size > 0 and float(roi.mean()) < 8.0

    src_first, src_last = frame_at(paths["video"], 0), frame_at(paths["video"], 179)
    for idx in (0, 179, 149, 150, 151):
        img = frame_at(out, idx)
        check(f"导出第 {idx} 帧遮挡块为黑色", rect_is_black(img, boxes[idx]))
    out_first, out_last = frame_at(out, 0), frame_at(out, 179)
    b0 = boxes[0]
    ox = int(b0[0] + b0[2]) + 30  # 框外一点应与原画一致
    check("导出首帧框外画面未被误遮",
          abs(int(out_first[300, ox].mean()) - int(src_first[300, ox].mean())) < 12)
    bl = boxes[179]
    check("导出末帧框外画面未被误遮",
          abs(int(out_last[600, 200].mean()) - int(src_last[600, 200].mean())) < 12)

    print()
    if FAILURES:
        print(f"共 {len(FAILURES)} 项失败: {FAILURES}")
        sys.exit(1)
    print("全部验证通过 ✔")


if __name__ == "__main__":
    main()
