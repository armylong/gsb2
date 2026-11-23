"""Offscreen UI smoke test: import, generate, correct, switch views, export."""
import os, sys, tempfile
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flatfield.app import create_app
from flatfield.ui.main_window import MainWindow
from flatfield.generator import generate_set
from flatfield.exports import export_corrected, export_masks, export_report

app = create_app([])
w = MainWindow()
w.resize(1500, 950)
w.show()
app.processEvents()

ds = generate_set((320, 420), n_dark=4, n_light=4)
w.load_dataset(ds)
app.processEvents()
print("issues:", [(i.severity, i.code) for i in w.session.issues])
print("views:", [w.view_combo.itemData(i) for i in range(w.view_combo.count())])
for key in ["corrected", "original", "dark_only", "flat_norm", "dark_mean", "light_mean"]:
    w.set_view(key)
    app.processEvents()
    print(key, "->", w.readout.text()[:80])

w.set_view("corrected")
app.processEvents()
w.grab().toImage().save("/tmp/ui_corrected.png", "PNG")
w.set_view("original")
app.processEvents()
w.grab().toImage().save("/tmp/ui_original.png", "PNG")
w.set_view("flat_norm")
app.processEvents()
w.grab().toImage().save("/tmp/ui_flat.png", "PNG")

w.set_view("corrected")
w.defect_panel.select_component(w.session.model.defects.components[0].id)
app.processEvents()
print("detail:", w.defect_panel.detail.text()[:120].replace("\n", " | "))
large_before = len(w.session.model.defects.large_components)
w.defect_panel.group.buttons()[1].setChecked(True)  # small patches
app.processEvents()
print("policy", w.session.patch_policy, "patched", int(w.session.model.patched_mask.sum()),
      "large", large_before)

w.dark_check.setChecked(False)
app.processEvents()
print("dark off ->", w.readout.text()[:80])
w.dark_check.setChecked(True)
w.light_check.setChecked(False)
app.processEvents()
print("light off ->", w.readout.text()[:80])
w.light_check.setChecked(True)
app.processEvents()

tmp = tempfile.mkdtemp()
corr = w.session.ensure_correction()
p1 = export_corrected(tmp, corr, w.session.model, w.session.sample.name, w.session.sample.meta)
p2 = export_masks(tmp, w.session.model, prefix="refmask", stem="sample")
p3 = export_report(tmp, {"kind": "smoke", **w.session.evidence()})
print("exports:", [x.name for x in p1.written + p2.written] + [p3.name])
print("variants:", [v["label"] for v in w.session.verify().to_dict()["variants"]])
w.grab().toImage().save("/tmp/ui_final.png", "PNG")
print("OK")

# verify tab screenshot
w.verify_dock.raise_()
app.processEvents()
w.grab().toImage().save("/tmp/ui_verify.png", "PNG")
w.set_view("dark_only")
w.dark_check.setChecked(True); w.light_check.setChecked(True)
app.processEvents()
w.grab().toImage().save("/tmp/ui_darkonly.png", "PNG")
w.view_combo.setCurrentIndex(0)
app.processEvents()
w.image_view.set_marker(*w.session.model.defects.components[0].center)
w.image_view.focus_on(*w.session.model.defects.components[0].center, zoom=6)
w.defect_panel.select_component(w.session.model.defects.components[0].id)
app.processEvents()
w.grab().toImage().save("/tmp/ui_zoom.png", "PNG")
