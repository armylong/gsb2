"""GUI 冒烟测试（offscreen，无需显示器）：覆盖主要交互路径。"""

from __future__ import annotations

import faulthandler
import os
import sys
import tempfile
from pathlib import Path

faulthandler.dump_traceback_later(60)

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def log(msg: str) -> None:
    print(f"[smoke] {msg}", flush=True)

from PySide6.QtWidgets import QApplication

from colorcalib.gui.mainwindow import MainWindow
from colorcalib.gui.qtimage import load_image
from colorcalib.project import load_project
from colorcalib.sampling import ROIRect

app = QApplication([])
win = MainWindow()
win.show()
log("window shown")

# 1. 内置样例
win.load_builtin_sample()
log("sample loaded")
assert win.image is not None and len(win.references) == 12
assert len(win.view.get_rois()) == 12

# 2. 留两格做检查、停用反光格 B3
win.apply_role("B1", "check")
win.apply_role("C4", "check")
win.apply_enabled("B3", False)
rois = {r.patch_id: r for r in win.view.get_rois()}
assert rois["B1"].role == "check" and not rois["B3"].enabled
log("roles + disable applied")

# 3. 两种模型都应拟合并产出修正图
assert win.model_full is not None, win.calib_error
assert win.model_wb is not None
assert win.corrected_full.shape == win.image.shape
log("models fitted")

# 4. 残差表行数与“检查”标记
assert win.panel_calib.table.rowCount() == 12
held_text = win.panel_preview.info.text()
assert "越界像素" in held_text

# 5. 切换预览模式（含白平衡对照与遮罩），不应崩溃
for mode in ["original", "corrected", "white_balance", "clipping"]:
    win.panel_preview.set_mode(mode)
    app.processEvents()
log("preview modes cycled")

# 6. 切到白平衡模型再切回
win.panel_calib.rb_wb.setChecked(True)
app.processEvents()
win.panel_calib.rb_full.setChecked(True)
app.processEvents()
assert win.model_full is not None
log("model switch ok")

# 7. 导出 PNG，并验证导出图与预览同规则
with tempfile.TemporaryDirectory() as tmp:
    out = os.path.join(tmp, "out.png")
    win.panel_preview.set_mode("corrected")
    app.processEvents()
    win.export_image(out)
    log("image exported")
    exported = load_image(out)
    assert exported.shape == win.image.shape
    # 同规则：导出像素 == 预览转换后的 uint8
    from colorcalib.gui.qtimage import to_uint8
    expected, _ = to_uint8(win.corrected_full)
    assert (exported == expected).all(), "导出与预览颜色约定不一致"

    # 8. 保存/重开项目设置
    proj = os.path.join(tmp, "settings.json")
    # 内置样例路径是占位符，先赋一个真实存在的图片路径（用导出的 PNG）
    win.image_path = out
    win.reference_path = str(
        Path(__file__).resolve().parents[1] / "examples" / "sample_reference.csv"
    )
    from colorcalib.project import save_project
    save_project(
        proj,
        image_path=win.image_path,
        reference_path=win.reference_path,
        rois=win.view.get_rois(),
        model_kind="full",
    )
    data = load_project(proj)
    assert len(data["rois"]) == 12
    reopened = {r.patch_id: r for r in data["rois"]}
    assert reopened["B1"].role == "check"
    assert reopened["B3"].enabled is False
log("project roundtrip ok")

# 9. 参考色卡重新加载不改原图
before = win.image.copy()
win.reload_reference()
assert (win.image == before).all()
log("reference reload leaves image untouched")

# 10. 退化情况：只留两个拟合格，应显示失败而不崩溃
for roi in win.view.get_rois():
    if roi.role == "fit" and roi.patch_id not in ("A1", "A2"):
        win.apply_enabled(roi.patch_id, False)
app.processEvents()
assert win.model_full is None
assert "算不出可靠修正" in win.panel_calib.diagnostic.text()
log("degenerate input handled")

print("GUI 冒烟测试全部通过")
