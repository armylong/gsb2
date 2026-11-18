from __future__ import annotations

import numpy as np
import pytest

from drumchopper.player import AudioPlayer


class FakeStream:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.active = False
        self.aborted = 0
        self.started = 0

    def start(self):
        self.active = True
        self.started += 1

    def stop(self, ignore_errors=False):
        self.active = False

    def abort(self, ignore_errors=False):
        self.aborted += 1
        self.active = False

    def close(self, ignore_errors=False):
        self.active = False


@pytest.fixture()
def player(monkeypatch):
    p = AudioPlayer(samplerate=1000, channels=2)
    streams: list[FakeStream] = []

    def fake_ensure():
        if p._stream is None:
            p._stream = FakeStream()
            p._stream.start()
            streams.append(p._stream)
        elif not p._stream.active:
            p._stream.start()
        return True

    monkeypatch.setattr(p, "_ensure_stream", fake_ensure)
    p._streams = streams
    return p


def buffer(n=1000, value=0.2, channels=2):
    return np.full((n, channels), value, dtype=np.float32)


def pull(player, frames: int) -> np.ndarray:
    out = np.zeros((frames, player.channels), dtype=np.float32)
    player._callback(out, frames, None, None)
    return out


def test_play_and_callback_fill_output(player):
    assert player.play(buffer(1000), loop=False)
    out = pull(player, 256)
    assert np.allclose(out, 0.2)
    assert player.playing


def test_mono_buffer_is_duplicated_not_dropped(player):
    mono = np.full(500, 0.3, dtype=np.float32)
    assert player.play(mono)
    out = pull(player, 64)
    assert out.shape == (64, 2)
    assert np.allclose(out, 0.3)


def test_stop_discards_queued_audio_and_next_play_uses_new_buffer(player):
    player.play(buffer(1000, 0.5))
    pull(player, 128)
    player.stop()
    out = pull(player, 128)
    assert np.all(out == 0), "停止后不能还有上一轮的残留声音"
    player.play(buffer(1000, 0.1))
    out = pull(player, 128)
    assert np.allclose(out, 0.1), "新一轮播放不能混入上一轮"
    stream = player._streams[0]
    assert stream.aborted >= 1, "停止应丢弃设备队列"


def test_play_while_playing_replaces_instead_of_layering(player):
    player.play(buffer(1000, 0.5))
    pull(player, 64)
    player.play(buffer(1000, 0.1))
    out = pull(player, 64)
    assert np.allclose(out, 0.1)


def test_loop_wraps_at_buffer_end(player):
    audio = np.zeros((100, 2), dtype=np.float32)
    audio[:10, :] = 0.4
    player.play(audio, loop=True)
    out = pull(player, 200)
    assert np.allclose(out[:10], 0.4)
    assert np.all(out[10:100] == 0)
    assert np.allclose(out[100:110], 0.4), "循环应回到开头"
    assert player.playing


def test_non_loop_finishes_and_calls_on_finished_once(player):
    called = []
    player.play(buffer(10), loop=False, on_finished=lambda: called.append(1))
    pull(player, 64)
    assert not player.playing
    import time
    for _ in range(50):
        if called:
            break
        time.sleep(0.01)
    assert called == [1]


def test_generation_counter_blocks_stale_position_updates(player):
    player.play(buffer(1000, 0.5))
    pull(player, 32)
    # simulate a racing block: capture state, then stop, then let callback write
    with player._lock:
        gen = player._generation
    player.stop()
    assert gen != player._generation
    out = pull(player, 32)
    assert np.all(out == 0)
