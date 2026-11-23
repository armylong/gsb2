"""Generate sample files (16-bit PNG/TIFF/PGM, npz bundle) into artifacts/samples."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pathlib import Path

from flatfield.generator import generate_set, save_set
from flatfield.io import write_ascii_pgm, write_png

out = Path("artifacts/samples")
out.mkdir(parents=True, exist_ok=True)
ds = generate_set((360, 480), seed=424242, n_dark=3, n_light=4)
info = save_set(ds, out)
# extra format variants for import checks
write_png(out / "flat_png.png", ds.lights[0].array, ds.meta)
from PIL import Image
Image.fromarray(ds.lights[0].array).save(out / "flat_tiff16.tif")
write_ascii_pgm(out / "flat_pgm16.pgm", ds.lights[0].array)
(out / "README.txt").write_text(
    "flatfield synthetic sample set\n"
    "- dark_*.png / light_*.png / sample.png: 16-bit PNG\n"
    "- bundle.json / bundle.npz: reference bundle for import\n"
    "- ground_truth.npz: known bias/vignette/texture for self-check\n"
    "- truth_*_mask.png: 0/65535 masks\n"
    "- flat_tiff16.tif / flat_pgm16.pgm: same frame in other formats\n",
    "utf-8")
print(json.dumps(info, indent=2, ensure_ascii=False))
