"""验证自生成测试信号: 双声道差异、噪声位置与首尾选区素材齐全。"""

from __future__ import annotations

import os

import numpy as np
import soundfile as sf

from tools.make_test_signals import (
    BURSTS, DURATION, SR, TONE_FREQ, TONE_T0, TONE_T1, generate,
)


def test_generate_assets(tmp_path):
    info = generate(str(tmp_path))
    assert os.path.exists(info["clean"])
    assert os.path.exists(info["damaged"])
    assert os.path.exists(info["manifest"])

    clean, sr0 = sf.read(info["clean"], dtype="float64")
    damaged, sr1 = sf.read(info["damaged"], dtype="float64")
    assert sr0 == sr1 == SR
    assert clean.shape == damaged.shape
    assert clean.ndim == 2 and clean.shape[1] == 2
    n = clean.shape[0]
    assert abs(n / SR - DURATION) < 0.05
    assert DURATION <= 60.0


def test_channels_are_different(tmp_path):
    info = generate(str(tmp_path))
    clean, _ = sf.read(info["clean"], dtype="float64")
    # 左右声道不是折叠单声道
    assert not np.allclose(clean[:, 0], clean[:, 1])
    corr = np.corrcoef(clean[:, 0], clean[:, 1])[0, 1]
    assert abs(corr) < 0.5, f"左右声道相关性过高 ({corr:.2f}), 差异不足"


def test_tone_only_in_left_channel(tmp_path):
    info = generate(str(tmp_path))
    clean, _ = sf.read(info["clean"], dtype="float64")
    damaged, _ = sf.read(info["damaged"], dtype="float64")
    i0, i1 = int(TONE_T0 * SR), int(TONE_T1 * SR)
    # 右声道在窄带窗口内与干净版逐样本一致 (干扰没有串到右侧)
    np.testing.assert_array_equal(damaged[i0:i1, 1], clean[i0:i1, 1])
    # 左声道确实被加入了干扰
    assert not np.allclose(damaged[i0:i1, 0], clean[i0:i1, 0])


def test_bursts_near_both_edges(tmp_path):
    info = generate(str(tmp_path))
    damaged, _ = sf.read(info["damaged"], dtype="float64")
    clean, _ = sf.read(info["clean"], dtype="float64")
    head0, head1 = BURSTS[0]
    tail0, tail1 = BURSTS[-1]
    assert head0 < 0.3, "首段异常应靠近开头"
    assert DURATION - tail1 < 0.5, "末段异常应靠近结尾"
    for b0, b1 in BURSTS:
        j0, j1 = int(b0 * SR), int(b1 * SR)
        assert np.max(np.abs(damaged[j0:j1] - clean[j0:j1])) > 0.1


def test_manifest_documents_locations(tmp_path):
    info = generate(str(tmp_path))
    text = open(info["manifest"], encoding="utf-8").read()
    assert f"{TONE_FREQ:.1f} Hz" in text
    assert "burst" in text
    assert "左声道" in text
