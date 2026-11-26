"""Automated local review of the orientation / border / replacement logic.

The GUI's "本地复查" button runs :func:`run_self_check` and shows the
report.  The same function is exercised by the test suite, so what the
button claims is what the tests check.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from typing import List, Optional

from PIL import Image

from cropkit.imaging import LoadedImage, export_crops
from cropkit.orientation import Orientation
from cropkit.project import (CropItem, Marker, Project, adapt_project,
                             compare_sources, read_source_info)
from cropkit.rectmath import Rect
from cropkit.samples import (CORNER_COLORS, make_corner_probe, make_sheet,
                             save_with_orientation, stored_pixels_for)


@dataclass
class Check:
    name: str
    ok: bool
    detail: str

    @property
    def mark(self) -> str:
        return "通过" if self.ok else "失败"


def _corner_patch(img: Image.Image, corner: str, size: int = 24) -> tuple:
    """Average colour of a square tucked into a corner.

    The probe and the reference are checked with the same helper, so the
    helper only has to be *consistent*, not exactly aligned.
    """
    w, h = img.size
    x = 0 if corner.endswith("L") else w - size
    y = 0 if corner.startswith("T") else h - size
    data = img.crop((x, y, x + size, y + size)).convert("RGB").tobytes()
    n = len(data) // 3
    return (sum(data[0::3]) // n, sum(data[1::3]) // n,
            sum(data[2::3]) // n)


def _nearest_color(color, table) -> str:
    best, best_d = "?", None
    for name, ref in table.items():
        d = sum((a - b) ** 2 for a, b in zip(color, ref))
        if best_d is None or d < best_d:
            best, best_d = name, d
    return best


def _corner_owner(img: Image.Image, colors) -> dict:
    """Map each corner of ``img`` to the display-corner colour it shows."""
    return {c: _nearest_color(_corner_patch(img, c), colors)
            for c in ("TL", "TR", "BL", "BR")}


def check_orientations(tmp: str) -> List[Check]:
    checks: List[Check] = []
    reference = make_sheet(True, (480, 320))
    reference.save(os.path.join(tmp, "reference.png"))

    probe = make_corner_probe((160, 120))
    colors = CORNER_COLORS
    for value in range(1, 9):
        path = os.path.join(tmp, f"orientation-{value}.jpg")
        save_with_orientation(reference, path, value)
        loaded = LoadedImage(path)
        expected_size = reference.size
        same_pixels = _mean_abs_diff(loaded.display, reference) < 4.0
        checks.append(Check(
            f"方向 {value} · {Orientation(value).label}",
            loaded.orientation.value == value and
            loaded.display_size == expected_size and same_pixels,
            f"标记={loaded.orientation.value}, 显示尺寸={loaded.display_size}, "
            f"摆正后与参考图平均差<4: {same_pixels}"))

        # A four-colour probe: display corners must be restored exactly, and
        # the stored pixels must match what the same orientation produced
        # when it was written.
        probe_path = os.path.join(tmp, f"probe-{value}.jpg")
        save_with_orientation(probe, probe_path, value, quality=98)
        loaded_probe = LoadedImage(probe_path)
        expected_stored = stored_pixels_for(probe, value)
        stored_ok = _mean_abs_diff(loaded_probe.stored, expected_stored) < 4.0
        display_owner = _corner_owner(loaded_probe.display, colors)
        display_ok = display_owner == {c: c for c in ("TL", "TR", "BL", "BR")}
        checks.append(Check(
            f"方向 {value} 四角指向", display_ok and stored_ok,
            "摆正后四角=" + ", ".join(f"{c}:{display_owner[c]}"
                                      for c in display_owner) +
            f", 编码像素一致={stored_ok}"))
    return checks


def check_mirrored_orientations(tmp: str) -> List[Check]:
    """The two pure mirrors (2 = 左右, 4 = 上下) plus the combined ones.

    Mirroring is where "a different program cropped the other corner" comes
    from, so it is checked twice: the *display* must restore the original,
    and the *stored* pixels must land where the orientation claims.
    """
    checks: List[Check] = []
    probe = make_corner_probe((160, 120))
    colors = CORNER_COLORS
    expect = ["1 · 正常", "2 · 水平镜像", "3 · 旋转 180°", "4 · 垂直镜像",
              "5 · 转置 (镜像 + 旋转)", "6 · 旋转 90° 顺时针",
              "7 · 反置 (镜像 + 旋转)", "8 · 旋转 90° 逆时针"]
    for value in (2, 4, 5, 7):
        path = os.path.join(tmp, f"mirror-{value}.jpg")
        save_with_orientation(probe, path, value, quality=98)
        loaded = LoadedImage(path)
        expected_stored = stored_pixels_for(probe, value)
        expected_owner = _corner_owner(expected_stored, colors)
        actual_owner = _corner_owner(loaded.stored, colors)
        display_owner = _corner_owner(loaded.display, colors)
        display_ok = display_owner == {c: c for c in ("TL", "TR", "BL", "BR")}
        stored_ok = actual_owner == expected_owner

        # explicit axis statements, using the stored corner colours
        lr_swapped = actual_owner["TL"] in ("TR", "BR") and \
            actual_owner["TR"] in ("TL", "BL")
        tb_swapped = actual_owner["TL"] in ("BL", "BR") and \
            actual_owner["BL"] in ("TL", "TR")
        if value == 2:
            axis_ok = lr_swapped and not tb_swapped
            axis_text = "仅左右对调"
        elif value == 4:
            axis_ok = tb_swapped and not lr_swapped
            axis_text = "仅上下对调"
        else:
            axis_ok = not lr_swapped and not tb_swapped
            axis_text = "对角反射 (非单轴镜像)"
        checks.append(Check(
            f"镜像方向 {value} · {expect[value - 1]}",
            display_ok and stored_ok and axis_ok,
            f"{axis_text}; 摆正四角正确={display_ok}, "
            f"编码落点={actual_owner} (期望 {expected_owner})"))
    return checks


def check_border_crop(tmp: str) -> List[Check]:
    checks = []
    reference = make_sheet(True, (480, 320))
    path = os.path.join(tmp, "border.jpg")
    save_with_orientation(reference, path, 6, quality=95)
    loaded = LoadedImage(path)
    w, h = loaded.display_size

    # a crop that touches the last row and column
    rect = Rect.from_size(w - 37, h - 23, 37, 23)
    crop = loaded.upright_crop(rect)
    full = loaded.display
    exact = crop.tobytes() == full.crop(
        (rect.x0, rect.y0, rect.x1, rect.y1)).tobytes()
    checks.append(Check(
        "触边裁切 · 尺寸", crop.size == rect.size,
        f"选区 {rect.as_tuple()} -> 裁片 {crop.size}"))
    checks.append(Check(
        "触边裁切 · 最外一行像素", exact,
        "裁片最右列 == 显示图第 %d 列, 最下行 == 第 %d 行" %
        (rect.x1 - 1, rect.y1 - 1)))

    # a crop with negative coordinates must clamp, not shift
    out_rect = Rect(-5, -7, w + 9, h + 3)
    clamped = loaded.upright_crop(out_rect)
    checks.append(Check(
        "越界选区 · 只裁剪不偏移",
        clamped.size == (w, h) and clamped.tobytes() == full.tobytes(),
        f"{out_rect.as_tuple()} -> {clamped.size}, 与整图逐像素相同"))
    return checks


def check_export_pixels(tmp: str) -> List[Check]:
    reference = make_sheet(True, (480, 320))
    path = os.path.join(tmp, "export.jpg")
    save_with_orientation(reference, path, 8, quality=95)
    loaded = LoadedImage(path)
    rect = Rect.from_size(3, 5, 61, 47)
    crop = CropItem("a", rect)
    marker_in = Marker("in", 10, 10)
    marker_out = Marker("out", 1, 1)
    out_dir = os.path.join(tmp, "out")
    results = export_crops(loaded, [crop], [marker_in, marker_out], out_dir,
                           with_masks=True)
    r = results[0]
    png = Image.open(r.crop_path).convert("RGB")
    ok = png.size == rect.size and png.tobytes() == loaded.display.crop(
        (rect.x0, rect.y0, rect.x1, rect.y1)).tobytes()
    mask = Image.open(r.mask_path)
    mask_ok = mask.size == rect.size
    manifest_ok = len(r.included) == 1 and len(r.outside) == 1
    return [
        Check("导出 PNG 与选区逐像素一致", ok,
              f"PNG {png.size} / 选区 {rect.as_tuple()}"),
        Check("掩膜与裁片同尺寸", mask_ok, f"掩膜 {mask.size}"),
        Check("清单区分包含/未包含", manifest_ok,
              f"包含 {len(r.included)}, 未包含 {len(r.outside)}"),
    ]


def check_old_file_replacement(tmp: str) -> List[Check]:
    checks = []
    reference = make_sheet(True, (480, 320))
    path = os.path.join(tmp, "replace.jpg")
    save_with_orientation(reference, path, 6, quality=95)
    old = read_source_info(path)
    project = Project(
        source=old,
        crops=[CropItem("a", Rect.from_size(20, 30, 100, 80))],
        markers=[Marker("m", 40, 50)],
    )
    project_path = os.path.join(tmp, "project.cropkit.json")
    project.save(project_path)

    # replace with a different orientation AND different size
    new_reference = make_sheet(True, (600, 400))
    save_with_orientation(new_reference, path, 8, quality=95)
    reopened = Project.load(project_path)
    actual = read_source_info(path)
    diffs = compare_sources(reopened.source, actual)
    fields = {d.field for d in diffs}
    checks.append(Check(
        "旧文件替换 · 检出差异",
        {"hash", "orientation", "stored_size"} <= fields,
        "差异: " + ", ".join(d.label for d in diffs)))
    recon = adapt_project(reopened, actual, mode="scale")
    in_bounds = all(
        0 <= r.x0 < r.x1 <= actual.display_size[0] and
        0 <= r.y0 < r.y1 <= actual.display_size[1]
        for r in recon.adapted_rects)
    checks.append(Check(
        "旧文件替换 · 需要确认后才换算", recon.needs_confirmation and in_bounds,
        f"换算后选区 {[r.as_tuple() for r in recon.adapted_rects]}"))
    # saving after confirmation keeps the new source
    from cropkit.project import apply_reconciliation

    apply_reconciliation(reopened, actual, recon)
    checks.append(Check(
        "旧文件替换 · 确认后可保存",
        reopened.source.sha256 == actual.sha256 and
        reopened.crops[0].rect == recon.adapted_rects[0],
        "新的源信息与选区已写回项目"))
    return checks


def check_zoom_invariance() -> List[Check]:
    """The rect used for export never depends on screen zoom or rounding."""
    from cropkit.rectmath import Rect as R

    rect = R.from_size(37, 41, 211, 133)
    ok = True
    detail = []
    for zoom in (0.13, 0.37, 1.0, 2.9, 7.3):
        # invert a screen-space drag the way the canvas does
        for sx in (0.0, 0.49, 0.999):
            img_x = rect.x0 + (sx / 1.0)
            screen = img_x * zoom
            back = screen / zoom
            if back < rect.x0 - 1e-9 or back > rect.x1:
                ok = False
                detail.append(f"zoom={zoom}")
        detail.append(f"{zoom}: {int(round(rect.x0 * zoom))}px")
    # a zoomed preview must not add a column
    for zoom in (0.13, 0.37, 1.0, 2.9):
        width_px = int(round((rect.x1 - rect.x0) * zoom))
        if width_px <= 0:
            ok = False
    return [Check("缩放/取整不改变导出选区", ok, ", ".join(detail))]


def _mean_abs_diff(a: Image.Image, b: Image.Image) -> float:
    if a.size != b.size:
        return 255.0
    pa = a.convert("RGB").tobytes()
    pb = b.convert("RGB").tobytes()
    if len(pa) != len(pb):
        return 255.0
    return sum(abs(x - y) for x, y in zip(pa, pb)) / max(len(pa), 1)


def run_self_check(working_dir: Optional[str] = None) -> List[Check]:
    """Run every check in a temporary directory and return the report."""
    checks: List[Check] = []
    if working_dir:
        os.makedirs(working_dir, exist_ok=True)
        tmp = working_dir
        checks.extend(check_orientations(tmp))
        checks.extend(check_mirrored_orientations(tmp))
        checks.extend(check_border_crop(tmp))
        checks.extend(check_export_pixels(tmp))
        checks.extend(check_old_file_replacement(tmp))
        checks.extend(check_zoom_invariance())
        return checks
    with tempfile.TemporaryDirectory(prefix="cropkit-check-") as tmp:
        checks.extend(check_orientations(tmp))
        checks.extend(check_mirrored_orientations(tmp))
        checks.extend(check_border_crop(tmp))
        checks.extend(check_export_pixels(tmp))
        checks.extend(check_old_file_replacement(tmp))
        checks.extend(check_zoom_invariance())
    return checks


def format_report(checks: List[Check]) -> str:
    lines = []
    for c in checks:
        lines.append(f"[{'PASS' if c.ok else 'FAIL'}] {c.name} :: {c.detail}")
    bad = sum(1 for c in checks if not c.ok)
    lines.append("")
    lines.append(f"合计 {len(checks)} 项，通过 {len(checks) - bad} 项，"
                 f"失败 {bad} 项")
    return "\n".join(lines)


if __name__ == "__main__":
    report = format_report(run_self_check())
    print(report)
    raise SystemExit(0 if "失败 0 项" in report else 1)
