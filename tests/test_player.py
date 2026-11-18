"""播放器测试：直接调用回调，不依赖真实音频设备。

验证：位置推进、增益斜坡连续（无爆音）、淡入包络、模式切换、
区间停止/循环、暂停停止跳转后位置与应输出帧一致。
"""

import numpy as np
import pytest

from mstool.audio_engine import (
    MODE_MID,
    MODE_SIDE,
    MODE_STEREO,
    make_distinct_ms_signal,
)
from mstool.player import AudioPlayer

SR = 48000
BLOCK = 512


def _pull(player: AudioPlayer, frames: int = BLOCK) -> np.ndarray:
    out = np.zeros((frames, 2), dtype=np.float32)
    player._callback(out, frames, None, None)
    return out


@pytest.fixture
def player():
    sig = make_distinct_ms_signal(SR)
    p = AudioPlayer(sig, SR)
    yield p
    p.close()


def test_silence_until_play(player):
    out = _pull(player)
    assert np.all(out == 0)
    assert player.position() == 0


def test_play_advances_position_and_matches_dsp(player):
    player.play()
    out = _pull(player)
    assert player.position() == BLOCK
    # 淡入只影响前 480 个样本，最后 32 个样本应与引擎成品一致（增益 1）
    expected = make_distinct_ms_signal(SR)[:BLOCK]
    np.testing.assert_allclose(out[-32:], expected[-32:], atol=1e-6)


def test_gain_ramp_is_continuous(player):
    """播放中改增益：斜坡按固定全局斜率跨块延续，块边界无拐点跳变。

    用常量信号排除音频内容变化，输出差只来自增益斜坡。
    块边界两侧是两个相邻样本时刻，连续斜坡下应恰好相差一个斜坡步长
    （(目标-起点)/斜坡总样本），而不是 0 或更大的跳变。
    """
    const = AudioPlayer(np.full((SR, 2), 0.5), SR)
    const.play()
    _pull(const)
    const.set_gains(1.5, 1.8, 1.0)
    out1 = _pull(const)
    out2 = _pull(const)
    # 常量信号 0.5 是纯中间信号：M=0.5、S=0，L'=0.5*gm，
    # 故边界步长只由中间增益斜坡决定 = 0.5 * mid_step
    mid_step = 0.5 / const._ramp_total
    expected_step = 0.5 * mid_step
    np.testing.assert_allclose(
        np.abs(out2[0] - out1[-1]), expected_step, atol=1e-6)
    # 块内部相邻样本也严格是同一个步长（无拉链噪声）
    inner_gap = np.abs(np.diff(out1[100:200, 0]))
    np.testing.assert_allclose(inner_gap, expected_step, atol=1e-7)
    const.close()

    # 真实信号：斜坡参考时长 20ms≈960 样本，跳过足够块后收敛到目标增益
    player.play()
    _pull(player)
    player.set_gains(1.5, 1.8, 1.0)
    for _ in range(12):
        _pull(player)
    out = _pull(player)
    pos = player.position()
    mid = (player._src[:, 0] + player._src[:, 1]) / 2
    side = (player._src[:, 0] - player._src[:, 1]) / 2
    seg_m = mid[pos - BLOCK:pos]
    seg_s = side[pos - BLOCK:pos]
    exp = np.column_stack((1.5 * seg_m + 1.8 * seg_s,
                           1.5 * seg_m - 1.8 * seg_s))
    np.testing.assert_allclose(out, exp, atol=1e-5)


def test_pause_stop_position_consistency(player):
    player.play()
    _pull(player)
    _pull(player)
    assert player.position() == 2 * BLOCK
    player.pause()
    frozen = player.position()
    out = _pull(player)
    assert np.all(out == 0)
    assert player.position() == frozen  # 暂停后位置不动
    player.stop()
    assert player.position() == 0
    out = _pull(player)
    assert np.all(out == 0)


def test_seek_during_playback(player):
    player.play()
    _pull(player)
    target = 10000
    player.seek(target)
    _pull(player)
    assert player.position() == target + BLOCK


def test_mode_switch_keeps_product_gains(player):
    player.set_gains(1.2, 1.6, 1.0)
    player.play()
    _pull(player)
    player.set_mode(MODE_MID)
    out = _pull(player)
    pos = player.position()
    mid = (player._src[:, 0] + player._src[:, 1]) / 2
    # 单听中间：两声道相同，等于 M×中间增益（淡入段之后）
    np.testing.assert_allclose(out[-32:, 0], out[-32:, 1])
    np.testing.assert_allclose(out[-32:, 0], 1.2 * mid[pos - 32:pos], atol=1e-5)
    # 切回立体声，增益设置不变
    player.set_mode(MODE_STEREO)
    assert player._mid_gain == 1.2 and player._side_gain == 1.6


def test_solo_side_content(player):
    player.set_mode(MODE_SIDE)
    player.play()
    _pull(player)
    out = _pull(player)
    pos = player.position()
    side = (player._src[:, 0] - player._src[:, 1]) / 2
    np.testing.assert_allclose(out[-32:, 0], side[pos - 32:pos], atol=1e-5)


def test_region_stops_at_end(player):
    region = (0, BLOCK + 100)
    player.set_region(*region)
    player.play()
    _pull(player)
    out2 = _pull(player)
    assert not player.playing
    assert player.position() == BLOCK + 100
    # 超出区间的部分输出静音
    assert np.all(out2[100:] == 0)


def test_region_loop(player):
    region = (0, BLOCK + 100)
    player.set_region(*region, loop=True)
    player.play()
    _pull(player)
    _pull(player)  # 到区间尾，循环回起点
    assert player.playing
    assert player.position() < BLOCK + 100


def test_play_restarts_when_at_end(player):
    player.set_region(0, BLOCK)
    player.play()
    _pull(player)
    assert not player.playing
    assert player.position() == BLOCK
    player.play()
    assert player.position() == 0  # 到尾后再播放自动回到区间起点
    _pull(player)
    assert player.position() == BLOCK


def test_attenuation_applied_identically_both_channels(player):
    player.set_gains(1.0, 1.0, 0.5)
    player.play()
    out = _pull(player)
    expected = player._src[:BLOCK] * 0.5
    # 淡入段之后严格一致
    np.testing.assert_allclose(out[-32:], expected[-32:], atol=1e-6)


def test_sync_mode_change_triggers_fade(player):
    from mstool.audio_engine import Params
    player.play()
    _pull(player)
    player.sync_params(Params(1.0, 1.0, MODE_SIDE, False), 1.0)
    assert player._fade_remaining > 0
