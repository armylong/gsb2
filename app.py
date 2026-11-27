#!/usr/bin/env python3
"""双面透印试修窗口入口。

用法:
  .venv/bin/python app.py            # 启动窗口, 菜单里可生成合成样例
  .venv/bin/python app.py --selftest # 无头自检(无显示环境也能跑)
"""

import sys

from descan.gui import MainWindow
from PySide6.QtWidgets import QApplication


def selftest() -> int:
    """构造主窗口, 程序化走一遍: 合成数据 -> 加点对齐 -> 标定 -> 处理 -> 导出。"""
    import os
    import tempfile

    from PySide6.QtCore import QPointF
    from descan.bleed import LocalPatch
    from descan.synth import SynthConfig, generate_pair
    import cv2
    import numpy as np

    app = QApplication.instance() or QApplication([])
    win = MainWindow()
    win.show()

    data = generate_pair(SynthConfig())
    win.front_gray = data["front"]
    win.back_gray = data["back"]
    win.front_clean = data["front_clean"]
    win._reset_session_state()
    win.calib_rect = tuple(data["meta"]["calib_rect"])
    win.view_front.set_image_gray(win.front_gray)
    win.view_back.set_image_gray(win.back_gray)

    # 用真值错位反推点对
    cfg = SynthConfig()
    h, w = win.front_gray.shape
    m = cv2.getRotationMatrix2D((w / 2, h / 2), cfg.angle_deg, 1.0)
    m[0, 2] += cfg.shift[0]
    m[1, 2] += cfg.shift[1]
    inv = np.linalg.inv(np.vstack([m, [0, 0, 1]]))
    front_pts = [(150, 150), (w - 200, 150), (w - 200, h - 200), (150, h - 200)]
    for fx, fy in front_pts:
        x, y, z = inv @ np.array([fx, fy, 1.0])
        bx, by = x / z, y / z
        win.alignment.front_pts.append((float(fx), float(fy)))
        win.alignment.back_pts.append((float(w - bx), float(by)))
    win._do_align()
    assert win.alignment.is_ready, "对齐失败"

    win._do_calibrate()
    assert win.params.base_strength > 0, "标定失败"
    win._reprocess()
    assert win.result is not None and win.result.result.shape == win.front_gray.shape

    # 手绘一笔保护 + 一个局部块, 确认坐标按原图像素生效
    win.params.protect_strokes.append([(100, 100), (120, 130), (140, 160)])
    win.params.patches.append(LocalPatch(400, 400, 120, 90, 0.3))
    win._reprocess()
    hand = win.result.hand_protect
    assert hand[130, 120] > 0, "手绘保护未栅格化到原图像素"

    # 重处理不得复位用户的缩放/平移(标注钉在原图像素)
    win.view_front.scale = 3.21
    win.view_front.offset = QPointF(47.0, -88.0)
    win.view_back.scale = 2.05
    win.view_back.offset = QPointF(12.0, 33.0)
    win._reprocess()
    assert abs(win.view_front.scale - 3.21) < 1e-9
    assert abs(win.view_front.offset.x() - 47.0) < 1e-9
    assert abs(win.view_back.scale - 2.05) < 1e-9
    assert abs(win.view_back.offset.y() - 33.0) < 1e-9

    # 各视图模式都能渲染
    for idx in range(win.combo_front_view.count()):
        win.combo_front_view.setCurrentIndex(idx)
    win.chk_ref.setChecked(True)
    win.chk_cov.setChecked(True)
    win.chk_clean.setChecked(True)
    win._refresh_views()

    # 镜像切换后背面视图按新状态重建, 且对齐点仍在
    n_back_pts = len(win.alignment.back_pts)
    win.chk_mirror.setChecked(False)
    win.chk_mirror.setChecked(True)
    assert len(win.alignment.back_pts) == n_back_pts

    # 导出
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, "export.png")
        assert cv2.imwrite(out, win.result.result)
        reread = cv2.imread(out, 0)
        assert reread.shape == win.front_gray.shape
        # 覆盖区外必须与原图一致
        cov = win.coverage
        assert np.array_equal(reread[cov == 0], win.front_gray[cov == 0])

    print("GUI SELFTEST PASS: 对齐/标定/保护/局部块/视图/导出 全部通过")
    win.close()
    app.processEvents()
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(selftest())
    run_app = QApplication.instance() or QApplication(sys.argv)
    window = MainWindow()
    window.show()
    raise SystemExit(run_app.exec())
