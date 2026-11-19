"""可选的最小冒烟测试：用真实声卡播放极短片段。

默认跳过（需要音频输出设备且不能干扰用户）；跑法：
    REVERB_AUDIO_SMOKE=1 .venv/bin/python -m pytest -q -k audio_smoke
"""

from __future__ import annotations

import os

import numpy as np
import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("REVERB_AUDIO_SMOKE") != "1",
    reason="需要真实音频输出设备；设置 REVERB_AUDIO_SMOKE=1 才运行",
)


def test_audio_smoke_play_and_stop():
    from reverb_tool.player import Clip, Player

    sample_rate = 48000
    t = np.arange(int(0.15 * sample_rate)) / sample_rate
    tone = 0.05 * np.sin(2 * np.pi * 440 * t).astype(np.float32)
    stereo = np.repeat(tone[:, None], 2, axis=1)
    clip = Clip(samples=stereo, sample_rate=sample_rate, start_frame=0, total_frames=len(tone))
    player = Player()
    player.play(clip)
    player.stop()
    assert not player.active
    player.play(clip)
    assert player.wait_finished(timeout=5.0)
    assert not player.active
