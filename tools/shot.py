"""Render UI screenshots offscreen for review (no window server needed)."""
import json
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pathlib import Path

from flatfield.app import create_app
from flatfield.ui.generator_dialog import GeneratorDialog
from flatfield.ui.main_window import MainWindow
from flatfield.io import read_bundle
from flatfield.core import Frame

out = Path("/tmp/shots")
out.mkdir(exist_ok=True)
app = create_app([])

# 1. empty state
w = MainWindow(); w.resize(1600, 1000); w.show(); app.processEvents()
w.grab().toImage().save(str(out / "01_empty.png"), "PNG")

# 2. generator dialog
d = GeneratorDialog(w); d.show(); app.processEvents()
d.grab().toImage().save(str(out / "02_generator.png"), "PNG"); d.close()

# 3. sample bundle loaded from disk
b = read_bundle("artifacts/samples/bundle.json")
sess_frames = lambda items: [Frame(x.array, name=x.name(), meta=x.meta, path=str(x.path)) for x in items]
w.session.darks = sess_frames(b.dark)
w.session.lights = sess_frames(b.light)
w.session.set_sample(sess_frames([b.sample])[0])
w.session.attach_truth_adjacent("artifacts/samples/bundle.json")
w.import_dock.conditions.apply_to(w.session)
w._after_import()
app.processEvents()
w.grab().toImage().save(str(out / "03_loaded.png"), "PNG")

# 4. verify tab
w.verify_dock.raise_(); app.processEvents()
w.grab().toImage().save(str(out / "04_verify.png"), "PNG")

# 5. defect zoom + neighborhood
comp = w.session.model.defects.components[0]
w.right_dock.raise_()
w.defect_panel.select_component(comp.id)
w.image_view.focus_on(*comp.center, zoom=5)
w.image_view.set_marker(*comp.center)
app.processEvents()
w.grab().toImage().save(str(out / "05_defect_zoom.png"), "PNG")

# 6. only dark correction, display range narrowed manually
w.set_view("dark_only")
app.processEvents()
w.histogram._set_handle("lo", w.histogram._handle_x(w._display_range[0]) + 40)
app.processEvents()
w.grab().toImage().save(str(out / "06_dark_only_range.png"), "PNG")

# 7. switched off both
w.dark_check.setChecked(False); w.light_check.setChecked(False)
w.set_view("original"); app.processEvents()
w.grab().toImage().save(str(out / "07_uncorrected.png"), "PNG")
# 8. mask view
w.dark_check.setChecked(True); w.light_check.setChecked(True)
w.set_view("mask"); app.processEvents()
w.grab().toImage().save(str(out / "08_mask.png"), "PNG")
print(json.dumps([p.name for p in sorted(out.glob("*.png"))]))
