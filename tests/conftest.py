import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture(scope="session")
def samples_dir(tmp_path_factory) -> Path:
    """A session-scoped directory holding freshly generated demo WAVs."""
    from clipmend.samples import ensure_samples

    directory = tmp_path_factory.mktemp("sample-wavs")
    ensure_samples(directory)
    return directory


@pytest.fixture
def doc_short(samples_dir):
    from clipmend.document import Document

    doc = Document()
    doc.load_sample("short_peak", samples_dir)
    return doc


@pytest.fixture
def doc_long(samples_dir):
    from clipmend.document import Document

    doc = Document()
    doc.load_sample("long_flat", samples_dir)
    return doc
