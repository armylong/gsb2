"""Application entry point: window shell, menu, and the headless self-check.

``python -m resample_lab``             interactive
``python -m resample_lab --check ...`` run the numeric verification suite
``python -m resample_lab --export ...`` headless export of the current region
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtWidgets import (
    QApplication,
    QMainWindow,
    QMessageBox,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from . import core, samples
from .analysis_view import AnalysisTab


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("亚像素重采样实验台 — 缩小图标时的细线闪烁与边缘变黑")
        self.resize(1500, 1000)

        central = QWidget()
        layout = QVBoxLayout(central)
        layout.setContentsMargins(0, 0, 0, 0)
        self.tabs = QTabWidget()
        self.analysis = AnalysisTab()
        self.tabs.addTab(self.analysis, "对比分析")
        layout.addWidget(self.tabs)
        self.setCentralWidget(central)

        self.statusBar().showMessage("就绪")
        self.analysis.status.connect(self.statusBar().showMessage)
        self._build_menu()

    def _build_menu(self) -> None:
        file_menu = self.menuBar().addMenu("文件")
        quit_action = QAction("退出", self)
        quit_action.setShortcut(QKeySequence.StandardKey.Quit)
        quit_action.triggered.connect(self.close)
        file_menu.addAction(quit_action)

        help_menu = self.menuBar().addMenu("帮助")
        about = QAction("关于", self)
        about.triggered.connect(self._about)
        help_menu.addAction(about)

    def _about(self) -> None:
        QMessageBox.information(
            self,
            "关于",
            "亚像素重采样实验台\n\n"
            "直接插值 / 高斯预滤波 / 匹配盒预滤波 / 面积平均 的对比工具。\n"
            "所有样例均在内存中程序化生成。",
        )


# --------------------------------------------------------------------------- #
# Headless verification suite
# --------------------------------------------------------------------------- #
def run_checks(verbose: bool = True) -> tuple[bool, list[str]]:
    """Numeric invariants; returns (all_passed, report_lines).

    The suite deliberately asserts the *known physics* rather than golden
    numbers, so it keeps working if sample parameters change:

    * averaging filters (area, matched box) preserve mean alpha for periodic
      line/grid textures at every shrink factor, including 1x1;
    * direct interpolation of the same texture is scale-dependent and can miss
      the lines entirely;
    * premultiplied alpha keeps the icon's colour and rim brightness, straight
      alpha darkens the rim;
    * 1x1 works for absurd shrink factors (1e-4);
    * semi-transparent diagonal and odd ratios keep mean alpha within a few
      percent of the true source average.
    """
    lines: list[str] = []
    ok = True

    def check(name: str, condition: bool, detail: str) -> None:
        nonlocal ok
        ok = ok and bool(condition)
        lines.append(f"{'PASS' if condition else 'FAIL'}  {name}  ({detail})")

    def approx(a: float, b: float, tol: float) -> bool:
        return abs(a - b) <= tol

    image = samples.thin_lines(256, spacing=4, thickness=1)
    crop = core.Crop(0, 0, 255, 255)
    expected = float(image[:255, :255, 3].mean())

    # Averaging filters must integrate the whole region, including at 1x1.
    for key in ("area", "mean"):
        result = core.resample(image, crop, (1, 1), key)
        check(
            f"1x1 mean alpha [{key}]",
            approx(result.metrics.mean_alpha, expected, 1e-3),
            f"{result.metrics.mean_alpha:.5f} vs {expected:.5f}",
        )

    # No-prefilter filters are expected to fail that test -- that is the bug
    # being demonstrated, so assert the *symptom* instead.
    direct_1x1 = core.resample(image, crop, (1, 1), "direct").metrics.mean_alpha
    check(
        "1x1 direct misses the lines",
        abs(direct_1x1 - expected) > 0.15,
        f"{direct_1x1:.5f} vs true {expected:.5f}",
    )

    area = core.resample(image, crop, (1, 1), "area").rgba[0, 0]
    reference = image[:255, :255].mean(axis=(0, 1))
    check(
        "area 1x1 == crop mean (RGBA)",
        float(np.abs(area - reference).max()) < 1e-5,
        f"max diff {float(np.abs(area - reference).max()):.2e}",
    )

    # Flicker: area/box stay exactly on the true mean across scales; direct
    # interpolation swings around it and can go dark at some phases.
    fixed_crop, _, _ = core.placed_crop((256, 256), (192, 192))
    scales = [0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625]
    truth = 0.25
    for key in ("area", "mean"):
        values = [
            core.resample(image, fixed_crop, core.output_size(fixed_crop, s), key).metrics.mean_alpha
            for s in scales
        ]
        check(
            f"no flicker across scale [{key}]",
            all(approx(v, truth, 0.01) for v in values),
            f"max |err| {max(abs(v - truth) for v in values):.4f}",
        )
    direct_values = [
        core.resample(image, fixed_crop, core.output_size(fixed_crop, s), "direct").metrics.mean_alpha
        for s in scales
    ]
    check(
        "direct interpolation loses/mis-draws thin lines",
        max(direct_values) - min(direct_values) > 0.2,
        f"range {max(direct_values) - min(direct_values):.3f} over {scales}",
    )

    # Moving the window by a whole number of line spacings must not change the
    # answer for the averaging filters, provided the window covers a whole
    # number of periods.  (A sub-pixel *phase* offset is a different matter:
    # bilinear sampling of the same integer samples is phase-invariant by
    # construction, which is why "direct" has no phase sensitivity but does
    # miss lines between samples -- demonstrated by the scale sweep above.)
    periods = [0.0, 4.0, 8.0, 16.0, 32.0, 64.0]
    for key in ("area", "mean"):
        values = [
            core.resample(
                image,
                core.Crop(0, phase, 192, 192),
                (48, 48),
                key,
            ).metrics.mean_alpha
            for phase in periods
        ]
        check(
            f"period-aligned shift is neutral [{key}]",
            max(values) - min(values) < 0.01,
            f"range {max(values) - min(values):.4f}",
        )

    icon = samples.transparent_icon(256)
    icon_crop = core.Crop(0, 0, 256, 256)
    alpha = icon[..., 3].astype(np.float64)
    premult_ref = (icon[..., :3].astype(np.float64) * alpha[..., None]).sum(axis=(0, 1)) / alpha.sum()
    for key in core.FILTER_ORDER:
        result = core.resample(icon, icon_crop, (1, 1), key)
        got = result.rgba[0, 0, :3].astype(np.float64)
        check(
            f"premultiplied keeps icon colour [{key}]",
            float(np.abs(got - premult_ref).max()) < 2e-3,
            f"max |delta| {float(np.abs(got - premult_ref).max()):.2e}",
        )

    # Dark fringing: at a mid-scale shrink the premultiplied pipeline must
    # leave the AA rim at body brightness; the straight-alpha pipeline lets the
    # RGB=0 of transparent samples bleed in, so the rim darkens.
    for key in core.FILTER_ORDER:
        premul = core.resample(icon, icon_crop, (48, 48), key, premultiply=True).metrics
        straight = core.resample(icon, icon_crop, (48, 48), key, premultiply=False).metrics
        check(
            f"premultiplied has no dark rim [{key}]",
            abs(premul.edge_delta) < 0.02 or np.isnan(premul.edge_delta),
            f"edge-interior {premul.edge_delta:+.3f}",
        )
        check(
            f"straight alpha darkens the rim [{key}]",
            straight.edge_delta < premul.edge_delta - 0.03
            or (np.isnan(straight.edge_delta) and np.isnan(premul.edge_delta)),
            f"straight {straight.edge_delta:+.3f} vs pre {premul.edge_delta:+.3f}",
        )

    diagonal = samples.semi_transparent_diagonal(128, width=1.0, alpha=0.5)
    diag_truth = float(diagonal[..., 3].mean())
    for key in ("area", "mean", "gaussian"):
        result = core.resample(diagonal, core.Crop(0, 0, 128, 128), (4, 4), key)
        check(
            f"semi-transparent diagonal [key]",
            approx(result.metrics.mean_alpha, diag_truth, 0.002),
            f"{result.metrics.mean_alpha:.4f} vs {diag_truth:.4f}",
        )
    direct_diag = core.resample(
        diagonal, core.Crop(0, 0, 128, 128), (4, 4), "direct"
    ).metrics.mean_alpha
    check(
        "direct over-reads the diagonal",
        direct_diag > diag_truth * 2,
        f"{direct_diag:.4f} vs {diag_truth:.4f}",
    )

    grid = samples.odd_ratio_grid(255, period=3)
    grid_crop = core.Crop(0, 0, 255, 255)
    grid_truth = float(grid[:255, :255, 3].mean())
    for key in ("area", "mean"):
        result = core.resample(grid, grid_crop, (1, 1), key)
        check(
            f"odd 1/3 ratio [{key}]",
            approx(result.metrics.mean_alpha, grid_truth, 1e-3),
            f"{result.metrics.mean_alpha:.5f} vs {grid_truth:.5f}",
        )
    # 255 = 3 * 85 exactly: 85 blocks of 3 keep the bars aligned, and the area
    # filter must reproduce the source average at that odd ratio, while direct
    # sampling of a 1-px bar grid is very lucky/unlucky depending on phase.
    aligned = core.resample(grid, grid_crop, (85, 85), "area")
    check(
        "odd 3:1 ratio area average",
        approx(aligned.metrics.mean_alpha, grid_truth, 2e-3),
        f"{aligned.metrics.mean_alpha:.5f} vs {grid_truth:.5f}",
    )

    tiny = core.output_size(core.Crop(0, 0, 192, 192), 1e-4)
    check("extreme shrink clamps to >=1px", tiny == (1, 1), str(tiny))
    for key in core.FILTER_ORDER:
        result = core.resample(image, core.Crop(0, 0, 192, 192), tiny, key)
        check(
            f"1x1 finite [{key}]",
            bool(np.isfinite(result.rgba).all()),
            f"mean alpha {result.metrics.mean_alpha:.4f}",
        )

    # Specified pixels: the reported 8-bit value is exactly what a saved PNG
    # contains, so an export can be cross-checked against the same numbers.
    for key in core.FILTER_ORDER:
        result = core.resample(image, core.Crop(0, 0, 128, 128), (16, 16), key)
        probe = result.u8[7, 5]
        reloaded = _reload_png_pixel(result, 5, 7)
        check(
            f"exported pixel matches PNG [{key}]",
            reloaded is not None and np.array_equal(probe, reloaded),
            f"({probe.tolist()}) vs {None if reloaded is None else reloaded.tolist()}",
        )

    # Semi-transparent diagonal with an odd output size: the total alpha of the
    # region is a conserved quantity, so any odd ratio must preserve it.
    for out_size in [(3, 3), (5, 7), (11, 13)]:
        values = [
            core.resample(diagonal, core.Crop(0, 0, 128, 128), out_size, key).metrics.mean_alpha
            for key in ("area", "mean")
        ]
        check(
            f"diagonal conserved at {out_size[0]}x{out_size[1]}",
            all(approx(v, diag_truth, 0.004) for v in values),
            f"{['%.4f' % v for v in values]} vs {diag_truth:.4f}",
        )

    if verbose:
        print("\n".join(lines))
    return ok, lines


def _build_headless_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m resample_lab")
    parser.add_argument("--check", action="store_true", help="运行数值验证并退出")
    parser.add_argument("--export", metavar="DIR", help="无界面导出当前区域到目录")
    parser.add_argument("--sample", default="lines", choices=samples.SAMPLE_ORDER)
    parser.add_argument("--source-size", type=int, default=256)
    parser.add_argument("--crop-size", type=int, default=192)
    parser.add_argument("--scale", type=float, default=0.25)
    parser.add_argument("--offset-x", type=float, default=0.0)
    parser.add_argument("--offset-y", type=float, default=0.0)
    parser.add_argument("--out-size", type=int, nargs=2, metavar=("W", "H"))
    parser.add_argument("--no-premultiply", action="store_true")
    parser.add_argument("--pixels", default="0,0; 1,1")
    parser.add_argument("--zoom", type=int, default=16)
    parser.add_argument("--sweep-steps", type=int, default=64)
    return parser


def export_headless(args: argparse.Namespace) -> int:
    image = samples.make_sample(args.sample, args.source_size)
    crop, dx, dy = core.placed_crop(
        (args.source_size, args.source_size),
        (args.crop_size, args.crop_size),
        args.offset_x,
        args.offset_y,
    )
    out_size = tuple(args.out_size) if args.out_size else core.output_size(crop, args.scale)
    premul = not args.no_premultiply
    os.makedirs(args.export, exist_ok=True)

    core.save_png(os.path.join(args.export, "source.png"), image)
    manifest = {
        "sample": args.sample,
        "sample_name": samples.SAMPLES[args.sample][0],
        "source_size": [args.source_size, args.source_size],
        "crop": {"x0": crop.x0, "y0": crop.y0, "width": crop.width, "height": crop.height},
        "requested_offset": [args.offset_x, args.offset_y],
        "actual_offset": [dx, dy],
        "output_size": list(out_size),
        "output_scale": list(core.output_scale(crop, out_size)),
        "premultiply_alpha": premul,
        "filters": {},
        "pixels": {},
        "pixels_by_name": {},
    }
    pixels = _parse_pixels(args.pixels, *out_size)
    for key in core.FILTER_ORDER:
        result = core.resample(image, crop, out_size, key, premul)
        core.save_png(os.path.join(args.export, f"{key}.png"), result.rgba)
        core.save_png(
            os.path.join(args.export, f"{key}_view.png"),
            samples.nearest_zoom(samples.checkerboard_backdrop(result.rgba), args.zoom),
        )
        manifest["filters"][key] = {"name": result.filter_name, "metrics": result.metrics.as_dict()}
        manifest["pixels"][key] = [
            {"x": x, "y": y, "rgba": [int(v) for v in result.u8[y, x]]} for x, y in pixels
        ]
    for x, y in pixels:
        manifest["pixels_by_name"][f"{x},{y}"] = {
            "x": x,
            "y": y,
            "exported_srgb": {
                key: [int(v) for v in core.resample(image, crop, out_size, key, premul).u8[y, x]]
                for key in core.FILTER_ORDER
            },
        }

    scales = np.linspace(max(args.scale * 0.25, 1e-4), min(args.scale * 4.0, 4.0), args.sweep_steps)
    manifest["sweeps"] = {
        "scale": _write_sweep(
            os.path.join(args.export, "sweep_scale.csv"),
            "scale",
            core.sweep_scales(image, (args.crop_size, args.crop_size), scales, premul),
        ),
        "offset_x": _write_sweep(
            os.path.join(args.export, "sweep_offset_x.csv"),
            "dx",
            core.sweep_offsets(
                image, (args.crop_size, args.crop_size), np.linspace(-1, 1, args.sweep_steps), "x", args.scale, premul
            ),
        ),
        "offset_y": _write_sweep(
            os.path.join(args.export, "sweep_offset_y.csv"),
            "dy",
            core.sweep_offsets(
                image, (args.crop_size, args.crop_size), np.linspace(-1, 1, args.sweep_steps), "y", args.scale, premul
            ),
        ),
    }
    with open(os.path.join(args.export, "summary.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, ensure_ascii=False)
    print(json.dumps(manifest["filters"], indent=2, ensure_ascii=False))
    print(f"exported to {os.path.abspath(args.export)}")
    return 0


def _parse_pixels(text: str, width: int, height: int) -> list[tuple[int, int]]:
    nums = []
    for chunk in text.replace(";", ",").split(","):
        chunk = chunk.strip()
        if chunk:
            nums.append(int(chunk))
    pairs = []
    for i in range(0, len(nums) - 1, 2):
        pairs.append((min(max(nums[i], 0), width - 1), min(max(nums[i + 1], 0), height - 1)))
    return pairs


def _write_sweep(path: str, x_name: str, data: dict[str, list[core.SweepPoint]]) -> dict:
    fields = ["mean_alpha", "colour_luma", "edge_delta", "fringe_delta", "composite_luma"]
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(",".join(["filter", x_name, "out_w", "out_h"] + fields) + "\n")
        for key, points in data.items():
            for point in points:
                row = [key, f"{point.x:.6f}", str(point.size[0]), str(point.size[1])]
                row += [f"{getattr(point.metrics, f):.6f}" for f in fields]
                fh.write(",".join(row) + "\n")
    return {"rows": len(next(iter(data.values()))), "filters": list(data)}


def _reload_png_pixel(result: core.Result, x: int, y: int):
    """Round-trip through a temporary PNG to prove exported values match."""
    import tempfile

    from PySide6.QtGui import QImage

    fd, path = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        core.save_png(path, result.rgba)
        img = QImage(path)
        if img.isNull():
            return None
        img = img.convertToFormat(QImage.Format.Format_RGBA8888)
        colour = img.pixelColor(x, y)
        return np.array([colour.red(), colour.green(), colour.blue(), colour.alpha()], dtype=np.uint8)
    finally:
        os.unlink(path)


def main(argv: list[str] | None = None) -> int:
    parser = _build_headless_parser()
    args = parser.parse_args(argv)

    if args.check:
        passed, _ = run_checks()
        return 0 if passed else 1
    if args.export:
        return export_headless(args)

    app = QApplication.instance() or QApplication(sys.argv)
    app.setApplicationName("Resample Lab")
    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
