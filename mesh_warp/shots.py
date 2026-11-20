"""Developer tool: capture GUI screenshots in offscreen mode.

Usage::

    QT_QPA_PLATFORM=offscreen python -m mesh_warp.shots --out docs/shots

Not part of the shipped app; handy for reviewing the UI without a display.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Capture mesh warp GUI screenshots")
    parser.add_argument("--out", default="docs/shots")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=860)
    args = parser.parse_args(argv)

    from PySide6.QtWidgets import QApplication

    from .gui.main_window import MainWindow

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    app = QApplication.instance() or QApplication([])
    window = MainWindow()
    window.resize(args.width, args.height)
    window.show()

    scenes = [
        ("01_identity", None),
        ("02_local_push", "push"),
        ("03_border_locked", "border"),
        ("04_invalid_fold", "invalid"),
    ]
    for name, scenario in scenes:
        window._load_test_scene(scenario)
        if scenario == "invalid":
            window._invalid_scenario()
        app.processEvents()
        path = out / f"{name}.png"
        window.grab().save(str(path))
        print(f"wrote {path}")

    # Sampling view: click the centroid of the first deformed triangle.
    window._load_test_scene("push")
    mesh = window.editor.mesh
    centroid = mesh.dst[mesh.tris[0]].mean(axis=0)
    window._on_sampled(float(centroid[0]), float(centroid[1]))
    app.processEvents()
    path = out / "05_sample.png"
    window.grab().save(str(path))
    print(f"wrote {path}")
    window.close()
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv[1:]))
