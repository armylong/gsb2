#!/usr/bin/env python3
"""Write the four built-in presets as PNG height maps (for trying the tool).

Run:  .venv/bin/python scripts/make_samples.py [output-dir]
Default output-dir: samples/
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from normalmap_tool.presets import PRESETS, PRESET_ORDER, generate_preset  # noqa: E402


def main(argv: list[str]) -> int:
    out = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parents[1] / "samples"
    out.mkdir(parents=True, exist_ok=True)
    for key in PRESET_ORDER:
        preset = generate_preset(key)
        path = out / f"{key}.png"
        cv2.imwrite(str(path), preset.codes)
        print(f"{PRESETS[key].label:<6} -> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
