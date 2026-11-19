"""离屏 GUI 冒烟测试: 不打开窗口, 走完 载入→对齐→合成→笔迹→撤销→导出 全流程。

运行: QT_QPA_PLATFORM=offscreen python -m tools.smoke_gui [--samples samples]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import cv2
from PySide6.QtWidgets import QApplication

from focusstack.alignment import AlignParams
from focusstack.app import MainWindow
from focusstack.pipeline import Stroke


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", default="samples")
    args = ap.parse_args()
    sdir = Path(args.samples)
    gt = json.loads((sdir / "ground_truth.json").read_text(encoding="utf-8"))

    app = QApplication([])
    win = MainWindow()

    # 载入样例(绕过文件对话框)
    for n in gt["images"]:
        img = cv2.imread(str(sdir / n), cv2.IMREAD_COLOR)
        win.images.append(img)
        win.names.append(n)
    win._structure_changed()
    assert win.results is not None, "载入后应完成自动合成"

    # 设置对齐参数(模拟用户手动对齐)并确认公共有效区存在
    win.aligns = [AlignParams(**a) for a in gt["align"]]
    win._recompute()
    x, y, w, h = win.results.crop
    assert w > 1000 and h > 700, f"公共有效区异常: {win.results.crop}"

    # 模拟一笔人工指定 + 撤销/重做
    win.strokes.append(Stroke(points=[(600.0, 400.0)], radius=30, source=0))
    win._recompute()
    assert (win.results.override >= 0).any(), "笔迹应生效"
    win._undo()
    assert not win.strokes and (win.results.override < 0).all(), "撤销后应恢复自动"
    win._redo()
    assert len(win.strokes) == 1 and (win.results.override >= 0).any(), "重做后笔迹应恢复"

    # 修改对齐参数后笔迹保留(按参考图坐标)
    win.aligns[1] = AlignParams(gt["align"][1]["dx"] + 1.0, gt["align"][1]["dy"], gt["align"][1]["scale"])
    win._recompute()
    assert len(win.strokes) == 1 and (win.results.override >= 0).any(), "改对齐后笔迹应保留"

    # 导出
    with tempfile.TemporaryDirectory() as td:
        from focusstack.export import export_all

        paths = export_all(td, win.names, win.ref, win.aligns, win.params, win.strokes, win.results)
        for p in paths.values():
            assert Path(p).exists(), f"缺少导出文件 {p}"

    print("GUI 冒烟测试通过: 载入/对齐/合成/笔迹/撤销重做/导出 均正常")
    return 0


if __name__ == "__main__":
    sys.exit(main())
