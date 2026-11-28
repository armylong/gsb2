"""把内置示例存成图片, 方便在外面用别的软件复查。

    python scripts/generate_examples.py out_dir
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from repeatcell import synth  # noqa: E402
from repeatcell.tiling import save_png  # noqa: E402


def main(argv) -> int:
    out = Path(argv[1] if len(argv) > 1 else "examples")
    out.mkdir(parents=True, exist_ok=True)
    for key, title in synth.list_examples():
        ex = synth.generate_example(key)
        path = out / f"{key}.png"
        save_png(path, ex.image)
        x, y, w, h = ex.region
        print(f"{path}  {ex.image.shape[1]}x{ex.image.shape[0]}  "
              f"region=({x},{y},{w},{h})  truth t1={ex.truth_t1} t2={ex.truth_t2}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
