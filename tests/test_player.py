"""帧精确播放器模型测试(不启动 Qt)。"""

from proxy_check.ffmedia import probe
from proxy_check.player import PlayerModel


def _model(paths):
    return PlayerModel(probe(paths["source"]), probe(paths["good"]))


def test_step_and_clamp(paths):
    m = _model(paths)
    assert m.index == 0
    m.step(10)
    assert m.index == 10
    m.step(-999)
    assert m.index == 0
    m.set_index(10_000)
    assert m.index == m.frame_count - 1 == 299


def test_switching_view_keeps_position(paths):
    m = _model(paths)
    m.set_index(123)
    # 模拟 GUI 的"切换显示一路": 模型本身位置不变。
    m.play()
    m.pause()
    assert m.index == 123
    assert m.source_ref().index == 123
    assert m.proxy_ref().index == 123


def test_frame_refs_times_and_pts(paths):
    m = _model(paths)
    m.set_index(30)
    s, d = m.source_ref(), m.proxy_ref()
    assert s.time == 1.0
    assert d.time == 1.0
    assert m.source_pts() == s.time
    assert m.frame_error() <= 1.0 / 30.0 + 1e-3


def test_playback_advance_stops_at_end(paths):
    m = _model(paths)
    m.set_index(298)
    m.play()
    assert m.advance() == 299
    assert m.advance() is None       # 越过末帧自动停
    assert m.playing is False


def test_proxy_index_clamped_when_shorter(paths, truncated_proxy):
    m = PlayerModel(probe(paths["source"]), probe(truncated_proxy))
    m.set_index(299)
    ref = m.proxy_ref()
    # 代理只有 270 帧时, 引用夹到末帧而不是越界。
    assert ref.index == 269
