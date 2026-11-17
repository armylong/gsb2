"""pytest 共享夹具：自生成带真值的测试场景（无需用户拍照/外部资源）。"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from panorama.config import Config
from panorama.engine import PanoramaEngine
from panorama.synthetic import build_synthetic_scene


@pytest.fixture(scope="session")
def cfg() -> Config:
    return Config()


@pytest.fixture()
def scene_dir(tmp_path) -> Path:
    d = tmp_path / "scene"
    build_synthetic_scene(d, n_frames=5)
    return d


@pytest.fixture()
def loop_dir(tmp_path) -> Path:
    d = tmp_path / "loop"
    build_synthetic_scene(d, n_frames=5, closed_loop=True)
    return d


@pytest.fixture()
def engine_with_scene(scene_dir) -> PanoramaEngine:
    eng = PanoramaEngine(Config())
    for p in sorted(scene_dir.glob("frame_*.png")):
        eng.add_photo(str(p))
    return eng


def _build_engine_with_unrelated(scene_dir) -> PanoramaEngine:
    eng = PanoramaEngine(Config())
    for p in sorted(scene_dir.glob("frame_*.png")):
        eng.add_photo(str(p))
    eng.add_photo(str(scene_dir / "unrelated.png"))
    return eng


@pytest.fixture()
def engine_with_unrelated(scene_dir) -> PanoramaEngine:
    return _build_engine_with_unrelated(scene_dir)
