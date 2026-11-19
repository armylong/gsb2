"""Export: PNG / mask / record round trips and preview consistency."""

from __future__ import annotations

import json

import numpy as np
import pytest

from mblend.color import linear_to_rgb8
from mblend.engine import MODE_NAIVE, MODE_PYRAMID, BlendConfig, BlendEngine
from mblend.export import ExportError, export_result, mask_to_gray8, read_png
from mblend.session import Session


def _mask_for(height: int, width: int) -> np.ndarray:
    mask = np.tile(
        np.linspace(0.0, 1.0, width, dtype=np.float32)[None, :], (height, 1)
    )
    mask[height // 4 : height // 2, width // 5 : width // 3] = 1.0
    mask[height // 2 : 3 * height // 4, 2 * width // 3 : 4 * width // 5] = 0.0
    return mask


def test_export_round_trip_matches_preview(tmp_path, odd_pair):
    a, b = odd_pair
    session = Session(a, b)
    session.mask_doc.mask[:] = _mask_for(*a.shape[:2])
    session.touch()
    info = session.export(str(tmp_path), "out")

    written = read_png(info.output_png)
    preview = session.result_rgb8()
    assert written.shape == preview.shape == (a.shape[0], a.shape[1], 3)
    assert np.array_equal(written, preview)

    mask_written = read_png(info.mask_png)
    assert mask_written.shape == a.shape[:2]
    assert np.array_equal(mask_written, mask_to_gray8(session.mask))

    record = json.loads(open(info.record_json, encoding="utf-8").read())
    assert record["width"] == a.shape[1]
    assert record["height"] == a.shape[0]
    assert record["levels"] == session.config.levels
    assert record["mode"] == MODE_PYRAMID


def test_export_ignores_inspected_level(tmp_path, odd_pair):
    a, b = odd_pair
    session = Session(a, b)
    session.mask_doc.mask[:] = _mask_for(*a.shape[:2])
    session.touch()
    session.set_inspected_level(0)
    first = session.export(str(tmp_path), "l0")
    session.set_inspected_level(session.config.levels - 1)
    second = session.export(str(tmp_path), "l3")
    assert np.array_equal(read_png(first.output_png), read_png(second.output_png))


def test_export_odd_size(tmp_path, odd_pair):
    a, _ = odd_pair
    session = Session(a, a)
    session.mask_doc.mask[:] = _mask_for(*a.shape[:2])
    session.touch()
    info = session.export(str(tmp_path), "odd")
    assert read_png(info.output_png).shape == (a.shape[0], a.shape[1], 3)
    assert read_png(info.mask_png).shape == a.shape[:2]


def test_export_naive_mode_writes_level_zero(tmp_path, odd_pair):
    a, b = odd_pair
    session = Session(a, b)
    session.set_mode(MODE_NAIVE)
    info = session.export(str(tmp_path), "naive")
    record = json.loads(open(info.record_json, encoding="utf-8").read())
    assert record["mode"] == MODE_NAIVE
    assert record["levels"] == 0


def test_export_endpoints_are_exact_files(tmp_path, odd_pair):
    a, b = odd_pair
    session = Session(a, b)
    session.mask_doc.fill_a()
    info = session.export(str(tmp_path), "only_a")
    assert np.array_equal(read_png(info.output_png), a)
    session.mask_doc.fill_b()
    info = session.export(str(tmp_path), "only_b")
    assert np.array_equal(read_png(info.output_png), b)


def test_export_rejects_bad_inputs(tmp_path, odd_pair):
    a, _ = odd_pair
    mask = np.zeros(a.shape[:2], np.float32)
    result = np.zeros_like(a, dtype=np.float32)
    with pytest.raises(ExportError, match="目录"):
        export_result(tmp_path / "missing", "x", result, mask, mode=MODE_PYRAMID, levels=4)
    with pytest.raises(ExportError, match="层"):
        export_result(tmp_path, "x", result, mask, mode=MODE_PYRAMID, levels=99)
    with pytest.raises(ExportError):
        export_result(tmp_path, "x", result, mask[:10], mode=MODE_PYRAMID, levels=4)


def test_export_mask_is_data_not_srgb():
    mask = np.array([[0.0, 0.25, 0.5, 1.0]], dtype=np.float32)
    gray = mask_to_gray8(mask)
    assert gray.tolist() == [[0, 64, 128, 255]]


def test_export_matches_independent_pipeline(tmp_path, random_pair):
    a, b = random_pair
    engine = BlendEngine(a, b)
    mask = _mask_for(*a.shape[:2])
    result = engine.result(mask, BlendConfig(MODE_PYRAMID, 4))
    info = export_result(tmp_path, "indep", result, mask, mode=MODE_PYRAMID, levels=4)
    assert np.array_equal(read_png(info.output_png), linear_to_rgb8(result))
