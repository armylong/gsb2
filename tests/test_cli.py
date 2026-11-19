"""命令行的退出码、JSON 输出与导出路径测试。"""
from __future__ import annotations

import csv
import json
import os

import numpy as np

from ccstats.cli import main
from ccstats.demos import DEMO_ORDER


def _run(argv):
    return main(argv)


def test_cli_demo_check_passes_for_every_demo_and_connectivity(capsys):
    for key in DEMO_ORDER:
        for conn in ("4", "8"):
            rc = _run(["demo", "--key", key, "--conn", conn, "--check"])
            assert rc == 0, (key, conn, capsys.readouterr().out)


def test_cli_demo_check_fails_with_wrong_expectation(monkeypatch, capsys):
    # 人为制造不一致：把演示图改成空白，校验必须返回 1
    import ccstats.cli as cli
    from ccstats.models import Demo

    real = cli.get_demo

    def fake_get_demo(key):
        d = real(key)
        return Demo(key=d.key, name=d.name, image=np.full_like(d.image, 235), expected=d.expected,
                    note=d.note)

    monkeypatch.setattr(cli, "get_demo", fake_get_demo)
    rc = _run(["demo", "--key", "diagonal", "--check"])
    assert rc == 1
    assert "校验：失败" in capsys.readouterr().out


def test_cli_unknown_parameter_combo_returns_2(capsys):
    rc = _run(["demo", "--key", "noise", "--despeckle", "9", "--check"])
    assert rc == 2
    assert "没有覆盖" in capsys.readouterr().err


def test_cli_json_reflects_filters_and_geometry(capsys):
    rc = _run(["demo", "--key", "circular", "--max-area", "1000", "--json"])
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["total"] == 4
    assert payload["included"] == 2
    assert payload["included_area"] == 613 + 317
    areas = sorted(r["面积(px)"] for r in payload["regions"])
    assert areas == [317, 613, 1257, 8966]
    reasons = sorted(r["排除原因"] for r in payload["regions"])
    assert reasons == ["计入", "计入", "面积大于上限", "面积大于上限"]


def test_cli_image_writes_export_files(tmp_path):
    import cv2
    img = np.full((120, 160), 235, np.uint8)
    img[20:50, 20:50] = 40
    img[80:100, 100:130] = 40
    src = tmp_path / "in.png"
    cv2.imwrite(str(src), img)
    out = tmp_path / "out"
    rc = _run(["image", str(src), "--export-dir", str(out)])
    assert rc == 0
    assert (out / "in_labels.png").exists()
    assert (out / "in_regions.csv").exists()
    assert (out / "in_inspection.png").exists()
    back = cv2.imread(str(out / "in_labels.png"), cv2.IMREAD_UNCHANGED)
    assert back is not None and back.shape == img.shape
    assert set(np.unique(back).tolist()) == {0, 1, 2}
    with open(out / "in_regions.csv", encoding="utf-8-sig") as f:
        rows = [r for r in csv.DictReader(f) if r["编号"] and not r["编号"].startswith("#")]
    assert sorted(int(r["面积(px)"]) for r in rows) == [600, 900]


def test_cli_missing_file_returns_2(tmp_path, capsys):
    rc = _run(["image", str(tmp_path / "nope.png")])
    assert rc == 2
    assert "错误" in capsys.readouterr().err
