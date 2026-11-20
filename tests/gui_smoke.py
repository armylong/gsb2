import os
import sys
import tempfile
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


def log(msg):
    print(msg, flush=True)


log("step1: import QApplication")
from PySide6.QtWidgets import QApplication
from alignment_tool.gui.main_window import MainWindow

app = QApplication([])
log("step2: construct MainWindow")
win = MainWindow()
log("step3: show")
win.show()
app.processEvents()
log(f"step4: est=({win.est.dx:.3f},{win.est.dy:.3f}) level={win.est.level}")

win.sp_manual_dx.setValue(win.sp_manual_dx.value() + 0.25)
win._nudge("y", -0.1)
app.processEvents()
log(f"step5: {win.lbl_move.text()} | rmse={win.lbl_rmse.text()}")

win.cmb_kind.setCurrentText("stripes")
win.on_generate()
app.processEvents()
log(f"step6: stripes -> {win.lbl_conf.text()}")

out = tempfile.mkdtemp()
win.edt_out.setText(out)
# 直接调用导出逻辑，避开模态 QMessageBox 在 offscreen 下的阻塞
from alignment_tool.io_utils import export_bundle
paths = export_bundle(out, win.ref, win.moving, win.sp_manual_dx.value(), win.sp_manual_dy.value())
log(f"step7: export -> {sorted(p.name for p in paths.values())}")

for k in ["dots", "blobs", "stripes", "low_texture", "checker"]:
    win.cmb_kind.setCurrentText(k)
    win.on_generate()
    app.processEvents()
log("step8: all texture kinds OK")
log("GUI offscreen smoke PASS")
