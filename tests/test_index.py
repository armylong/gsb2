import numpy as np

from cuefinder.audio import write_wav
from cuefinder.reference import ReferenceIndex


def _write(path, sig, sr=16000):
    write_wav(path, sig, sr)


def _cue(freq, dur=1.0):
    t = np.arange(int(dur * 16000)) / 16000
    return 0.6 * np.sin(2 * np.pi * freq * t)


def test_add_remove_reload_keeps_generation_consistent(tmp_path):
    idx = ReferenceIndex()
    p1 = tmp_path / "a.wav"
    p2 = tmp_path / "b.wav"
    _write(p1, _cue(440))
    _write(p2, _cue(660))
    a = idx.add(p1)
    b = idx.add(p2)
    assert a.ready and b.ready
    g0 = idx.generation
    idx.remove(str(p2))
    assert idx.generation == g0 + 1
    assert len(idx.ready()) == 1
    sig = idx.signature()
    idx.reload(str(p1))
    assert idx.signature() != sig


def test_signature_changes_when_file_replaced(tmp_path):
    idx = ReferenceIndex()
    p = tmp_path / "cue.wav"
    _write(p, _cue(440))
    ref = idx.add(p)
    sig_before = idx.signature()
    feats_before = ref.features.feats.copy()
    _write(p, _cue(880))
    idx.refresh_if_changed(str(p))
    assert idx.signature() != sig_before
    assert not np.allclose(feats_before, idx.get(str(p)).features.feats)


def test_bad_file_marks_error_without_affecting_others(tmp_path):
    idx = ReferenceIndex()
    good = tmp_path / "good.wav"
    bad = tmp_path / "bad.wav"
    _write(good, _cue(440))
    bad.write_bytes(b"garbage")
    idx.add(good)
    rbad = idx.add(bad)
    assert rbad.status == "error"
    assert len(idx.ready()) == 1
    assert idx.ready()[0].path.endswith("good.wav")


def test_silent_file_is_unusable(tmp_path):
    idx = ReferenceIndex()
    p = tmp_path / "silent.wav"
    write_wav(p, np.zeros(16000))
    r = idx.add(p)
    assert r.status in {"empty", "error"}
    assert not r.ready
