"""pytest 公共夹具：整个测试会话只生成一次测试素材。"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# 无显示环境下也能实例化 Qt 控件
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from greenscreen.generate_test_assets import generate  # noqa: E402
from greenscreen.media import VideoReader, load_image  # noqa: E402


@pytest.fixture(scope="session")
def assets(tmp_path_factory) -> dict:
    out = tmp_path_factory.mktemp("assets")
    paths = generate(str(out))
    return paths


@pytest.fixture(scope="session")
def reader(assets) -> VideoReader:
    r = VideoReader(str(assets["video"]))
    yield r
    r.close()


@pytest.fixture(scope="session")
def background(assets):
    return load_image(str(assets["background"]))
