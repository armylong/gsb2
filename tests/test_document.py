"""文档状态验证: 预览不叠加、取消不留半次修改、撤销/重做/恢复、
导出只写已确认状态、重开文件与预览一致。"""

from __future__ import annotations

import numpy as np
import pytest
import soundfile as sf

from audio_repair.document import AudioDocument, MAX_DURATION_S
from audio_repair.processing import ProcessOptions, Selection, SelectionError

SR = 44100


def _make_wav(path: str, stereo: bool = True, dur: float = 3.0) -> None:
    rng = np.random.default_rng(0)
    n = int(dur * SR)
    t = np.arange(n) / SR
    if stereo:
        data = np.stack([
            0.3 * np.sin(2 * np.pi * 300 * t),
            0.3 * np.sin(2 * np.pi * 420 * t),
        ], axis=1)
    else:
        data = 0.3 * np.sin(2 * np.pi * 300 * t)
    data += 0.01 * rng.standard_normal(n if not stereo else (n, 2))
    sf.write(path, data, SR, subtype="PCM_16")


@pytest.fixture()
def doc_with_file(tmp_path):
    path = tmp_path / "sample.wav"
    _make_wav(str(path))
    doc = AudioDocument()
    doc.load(str(path))
    return doc, str(path)


def _selection(n: int, ch=(0, 1)) -> Selection:
    return Selection(int(0.5 * SR), int(1.0 * SR), 2000.0, 3000.0, ch)


# ---------------------------------------------------------------------------

def test_load_validation(tmp_path):
    # 超长文件拒绝
    long_path = tmp_path / "long.wav"
    n = int((MAX_DURATION_S + 5) * SR)
    sf.write(str(long_path), np.zeros(n, dtype=np.float32), SR)
    doc = AudioDocument()
    with pytest.raises(SelectionError):
        doc.load(str(long_path))

    # 合法文件
    ok = tmp_path / "ok.wav"
    _make_wav(str(ok), stereo=False, dur=1.0)
    doc.load(str(ok))
    assert doc.n_channels == 1
    assert abs(doc.duration - 1.0) < 0.05


def test_preview_never_stacks(doc_with_file):
    doc, _ = doc_with_file
    sel = _selection(doc.n_samples)
    opt = ProcessOptions(strength=0.8)
    base = doc.confirmed.copy()
    # 反复建立预览 5 次: 每次都基于 confirmed, 结果必须完全一致
    results = []
    for _ in range(5):
        doc.make_preview(sel, opt)
        results.append(doc.preview.audio.copy())
    for r in results[1:]:
        np.testing.assert_array_equal(r, results[0])
    # confirmed 未被预览改动
    np.testing.assert_array_equal(doc.confirmed, base)


def test_cancel_preview_leaves_no_change(doc_with_file):
    doc, _ = doc_with_file
    before = doc.confirmed.copy()
    doc.make_preview(_selection(doc.n_samples), ProcessOptions())
    assert doc.has_preview
    doc.cancel_preview()
    assert not doc.has_preview
    np.testing.assert_array_equal(doc.confirmed, before)
    assert doc.working is doc.confirmed


def test_commit_then_undo_redo_restore(doc_with_file):
    doc, _ = doc_with_file
    original = doc.original.copy()
    sel = _selection(doc.n_samples)

    doc.make_preview(sel, ProcessOptions(strength=0.9))
    doc.commit_preview()
    committed = doc.confirmed.copy()
    assert not np.array_equal(committed, original)
    assert not doc.has_preview

    doc.undo()
    np.testing.assert_array_equal(doc.confirmed, original)
    doc.redo()
    np.testing.assert_array_equal(doc.confirmed, committed)

    doc.restore_original()
    np.testing.assert_array_equal(doc.confirmed, original)
    # 恢复原文件本身也可撤销
    doc.undo()
    np.testing.assert_array_equal(doc.confirmed, committed)


def test_undo_restores_both_channels_together(doc_with_file):
    doc, _ = doc_with_file
    sel = _selection(doc.n_samples, ch=(0, 1))
    before = doc.confirmed.copy()
    doc.make_preview(sel, ProcessOptions(strength=1.0))
    doc.commit_preview()
    doc.undo()
    # 联动操作的撤销必须同时恢复两侧
    np.testing.assert_array_equal(doc.confirmed[:, 0], before[:, 0])
    np.testing.assert_array_equal(doc.confirmed[:, 1], before[:, 1])


def test_history_limit(tmp_path):
    path = tmp_path / "s.wav"
    _make_wav(str(path), dur=2.0)
    doc = AudioDocument(history_limit=3)
    doc.load(str(path))
    sel = _selection(doc.n_samples)
    for strength in (0.2, 0.4, 0.6, 0.8, 1.0):
        doc.make_preview(sel, ProcessOptions(strength=strength))
        doc.commit_preview()
    assert len(doc._undo) == 3   # 只保留最近 3 次
    assert doc.can_undo


def test_export_writes_confirmed_only(doc_with_file, tmp_path):
    doc, _ = doc_with_file
    confirmed_before = doc.confirmed.copy()
    out = tmp_path / "export.wav"

    # 1) 有未确认预览时导出: 成品必须等于 confirmed
    doc.make_preview(_selection(doc.n_samples),
                     ProcessOptions(strength=1.0))
    preview_audio = doc.preview.audio.copy()
    doc.export(str(out))
    disk, sr = sf.read(str(out), dtype="float64")
    assert sr == SR
    # PCM_16 量化误差允许内, 与 confirmed 一致而与 preview 不同
    assert np.max(np.abs(disk - confirmed_before)) < 2e-4
    assert np.max(np.abs(disk - preview_audio)) > 1e-3

    # 2) 确认后再导出: 成品与确认状态一致
    doc.commit_preview()
    out2 = tmp_path / "export2.wav"
    doc.export(str(out2))
    disk2, _ = sf.read(str(out2), dtype="float64")
    assert np.max(np.abs(disk2 - doc.confirmed)) < 2e-4


def test_reopen_matches_committed_preview(doc_with_file, tmp_path):
    """确认 -> 导出 -> 重新打开: 重开内容与当时预听的修复结果一致。"""
    doc, _ = doc_with_file
    sel = _selection(doc.n_samples)
    doc.make_preview(sel, ProcessOptions(strength=0.9))
    preview = doc.preview.audio.copy()
    doc.commit_preview()
    out = tmp_path / "reopen.wav"
    doc.export(str(out))

    doc2 = AudioDocument()
    doc2.load(str(out))
    np.testing.assert_allclose(doc2.confirmed, preview, atol=2e-4)


def test_preview_cancel_during_adjustment(doc_with_file):
    doc, _ = doc_with_file
    sel = _selection(doc.n_samples)
    before = doc.confirmed.copy()
    doc.make_preview(sel, ProcessOptions(strength=0.5))
    doc.make_preview(sel, ProcessOptions(strength=0.9))  # 调整参数重建
    doc.cancel_preview()
    np.testing.assert_array_equal(doc.confirmed, before)
    # 再次预听仍是从 confirmed 重新计算, 不残留旧结果
    doc.make_preview(sel, ProcessOptions(strength=0.5))
    ref = doc.preview.audio.copy()
    doc.cancel_preview()
    doc.make_preview(sel, ProcessOptions(strength=0.5))
    np.testing.assert_array_equal(doc.preview.audio, ref)


def test_invalid_selection_feedback(doc_with_file):
    doc, _ = doc_with_file
    with pytest.raises(SelectionError):
        doc.validate_selection(
            Selection(0, 100, 500.0, 500.0, (0, 1)))  # 频率宽度为 0
    with pytest.raises(SelectionError):
        doc.validate_selection(
            Selection(0, 100, 100.0, 200.0, (9,)))     # 通道越界


def test_zero_strength_is_bit_exact(doc_with_file):
    doc, _ = doc_with_file
    sel = _selection(doc.n_samples)
    for mode in ("attenuate", "inpaint"):
        doc.make_preview(sel, ProcessOptions(mode=mode, strength=0.0))
        np.testing.assert_array_equal(doc.preview.audio, doc.confirmed)
        doc.cancel_preview()
