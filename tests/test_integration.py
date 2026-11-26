"""端到端：样例生成 → 载入 → 检索 → 变更参考 → 再检索。"""
import pytest

from cuefinder import demo
from cuefinder.audio import load_audio, write_wav
from cuefinder.reference import ReferenceIndex
from cuefinder.search import STATUS_AMBIGUOUS, STATUS_MATCH, search


@pytest.fixture(scope="module")
def samples(tmp_path_factory):
    out = tmp_path_factory.mktemp("samples")
    demo.generate(out)
    return out


def test_generated_layout(samples):
    refs = sorted((samples / "references").glob("*.wav"))
    queries = sorted((samples / "queries").glob("*.wav"))
    assert len(refs) == 4
    assert len(queries) == len(demo.CASE_QUERIES)
    assert (samples / "broken_ref.wav").exists()


def test_replace_reference_changes_result(samples, tmp_path):
    import shutil
    refs_dir = tmp_path / "refs"
    refs_dir.mkdir()
    for p in sorted((samples / "references").glob("*.wav")):
        shutil.copy(p, refs_dir / p.name)
    idx = ReferenceIndex()
    for p in sorted(refs_dir.glob("*.wav")):
        idx.add(str(p))
    q = load_audio(samples / "queries" / "correct_start.wav").samples
    out = search(idx, q, 0.55)
    assert out.best.label == "cue_b_trill"

    target = next(r for r in idx.all() if r.label == "cue_c_bell")
    source = refs_dir / "cue_b_trill.wav"
    write_wav(target.path, load_audio(source).samples)
    refreshed = idx.refresh_if_changed(target.path)
    assert refreshed is not None and refreshed.revision > 1

    out2 = search(idx, q, 0.55)
    assert out2.status == STATUS_AMBIGUOUS
    assert out2.index_signature != out.index_signature
    labels = {c.label for c in out2.candidates if c.score > 0.9}
    assert {"cue_b_trill", "cue_c_bell"} <= labels


def test_bad_file_does_not_break_index(samples):
    idx = ReferenceIndex()
    for p in sorted((samples / "references").glob("*.wav")):
        idx.add(str(p))
    before = len(idx.ready())
    bad = idx.add(str(samples / "broken_ref.wav"))
    assert not bad.ready
    assert len(idx.ready()) == before
    q = load_audio(samples / "queries" / "background_noise.wav").samples
    out = search(idx, q, 0.55)
    assert out.status == STATUS_MATCH
    assert out.best.label == "cue_c_bell"


def test_removing_reference_updates_signature(samples):
    idx = ReferenceIndex()
    for p in sorted((samples / "references").glob("*.wav")):
        idx.add(str(p))
    q = load_audio(samples / "queries" / "correct_start.wav").samples
    out = search(idx, q, 0.55)
    sig_before, gen_before = out.index_signature, out.generation
    idx.remove(out.best.path)
    out2 = search(idx, q, 0.55)
    assert out2.generation > gen_before
    assert out2.index_signature != sig_before
    assert out2.best.label != "cue_b_trill"
