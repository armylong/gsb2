"""GUI 冒烟测试:offscreen 平台启动主窗口并走一遍主要交互,无需真实显示器。

运行:
    python -m lce_lab.gui_smoke
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
from PySide6.QtWidgets import QApplication

from . import processing as P
from .app import MainWindow


def run() -> int:
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    app.processEvents()
    failures = 0

    def check(name, ok, detail=""):
        nonlocal failures
        failures += not ok
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""),
              flush=True)

    # 初始样例已处理
    check("启动即生成样例并处理", win.result is not None and win.image is not None)

    # 切换各样例
    for i, kind in enumerate(["blocks", "edge", "extreme", "color"]):
        win.cmb_sample.setCurrentIndex(i)
        app.processEvents()
        check(f"样例 {kind} 可处理", win.result is not None
              and win.result.image.shape == win.image.shape)
    win.cmb_sample.setCurrentIndex(0)

    # 三种模式
    win.rb_global.setChecked(True); app.processEvents(); win._rebuild()
    check("全局模式", win.params.mode == "global")
    win.rb_full.setChecked(True); app.processEvents(); win._rebuild()
    check("整图 CLAHE 模式", win.params.mode == "local_full")
    win.rb_mask.setChecked(True); app.processEvents(); win._rebuild()
    check("遮罩模式", win.params.mode == "local_mask")

    # 画两段相接遮罩(直接写点,模拟双击结束的结果)
    h, w = win.image.shape[:2]
    win.params.segments[0].points = [(0, 0), (w // 2, 0), (w // 2, h), (0, h)]
    win.params.segments[0].clip_limit = 5.0
    win.params.segments[1].points = [(w // 2, 0), (w, 0), (w, h), (w // 2, h)]
    win.params.segments[1].clip_limit = 15.0
    win._rebuild(); app.processEvents()
    # 两段恰好覆盖全图时外部为空,改为只画一段验证遮罩外不动
    win.params.segments[1].points = []
    win._rebuild(); app.processEvents()
    m = P.polygon_mask(win.image.shape, win.params.segments[0].points)
    check("GUI 遮罩外像素不动",
          np.array_equal(win.result.image[m == 0], win.image[m == 0]))

    # 检查块统计与参照锁定
    win.rb_full.setChecked(True); app.processEvents(); win._rebuild()
    rect = (20, 120, 32, 32)
    win.on_inspect_pinned(rect)
    check("固定块统计已显示", "实测对比变化" in win.lbl_stats.text())
    win.lock_reference()
    check("参照已锁定", win.reference_rect == rect and win.reference_id is not None)
    win.spn_strength.setValue(0.5)
    win._sync_params_from_widgets(); win._rebuild(); app.processEvents()
    check("调强度后参照同步报告", "噪声参照" in win.lbl_stats.text())

    # 切换图片后参照失效
    win.cmb_sample.setCurrentIndex(1); app.processEvents(); win._rebuild()
    check("切换图片后参照自动失效", win.reference_rect is None)

    # 视图切换
    for view in ("原图", "处理后", "差异(x4)", "标记叠加"):
        win.cmb_view.setCurrentText(view); app.processEvents()
    check("四种视图可切换", True)
    win.chk_markers.setChecked(True); app.processEvents()
    check("标记叠加可开关", win.canvas._show_markers)

    # 项目保存/恢复 + 导出确定性
    with tempfile.TemporaryDirectory() as td:
        proj = Path(td) / "p.lceproj"
        png = Path(td) / "out.png"
        P.save_project(proj, win.image, win.params, None)
        bgr2, p2, ref2, _ = P.load_project(proj)
        check("项目往返输入一致", np.array_equal(bgr2, win.image))
        exp_before = P.encode_png(P.process(win.image, win.params).image)
        exp_after = P.encode_png(P.process(bgr2, p2).image)
        check("同输入同参数导出一致", exp_before == exp_after)
        with open(png, "wb") as f:
            f.write(P.encode_png(P.process(win.image, win.params).image))
        check("PNG 可导出且可读", P.decode_png(png.read_bytes()).shape == win.image.shape)

    print("-" * 56)
    print("GUI 冒烟测试全部通过" if not failures else f"GUI 冒烟测试失败 {failures} 项")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(run())
