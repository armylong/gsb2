import json

import numpy as np
import numpy.testing as npt
import pytest

from tileviewer.cache import (
    CACHE_FORMAT_VERSION,
    CacheConfig,
    CacheManager,
    CancelledError,
    LevelState,
    build_level_array,
    stitch_tiles,
)
from tileviewer.geometry import Rect
from tileviewer.source import load_source


@pytest.fixture
def manager(tmp_path, source_png):
    source = load_source(source_png)
    config = CacheConfig(tile_size=16, margin=3, min_level_size=8)
    return CacheManager(tmp_path / "cache", source, config)


def test_generate_status_and_compare(manager):
    written = manager.generate()
    assert written == list(range(manager.info.level_count))
    for status in manager.statuses():
        assert status.state is LevelState.COMPLETE
        comparison = manager.compare_level(status.index)
        assert comparison.equal, comparison.describe()
        assert comparison.compared_pixels == status.width * status.height


def test_level_0_is_original_pixels(manager):
    manager.generate([0])
    npt.assert_array_equal(manager.stitch_level(0), manager.source.array)


def test_level_reference_is_ceiling_divided_size(manager):
    sizes = manager.info.sizes
    assert sizes[0] == (manager.source.width, manager.source.height)
    assert sizes[1] == ((sizes[0][0] + 1) // 2, (sizes[0][1] + 1) // 2)
    for index, size in enumerate(sizes):
        reference = build_level_array(manager.source, manager.info, index)
        assert reference.shape[:2] == (size[1], size[0])


def test_margin_tiles_store_overlap_but_stitching_uses_cores_only(manager):
    manager.generate([0])
    geom = manager.geometry(0)
    middle = geom.tile(1, 1)
    assert middle.full.w == middle.core.w + 6
    full = manager.read_tile_array(0, 1, 1)
    assert full.shape[:2] == (middle.full.h, middle.full.w)
    # The overlap contains real neighbouring pixels, not padding: the
    # top-left stored pixel must equal the source pixel at (core-1, core-1).
    npt.assert_array_equal(
        full[middle.top_margin - 1, middle.left_margin - 1],
        manager.source.array[middle.core.y - 1, middle.core.x - 1],
    )
    stitched = manager.stitch_level(0)
    npt.assert_array_equal(stitched, manager.source.array)


def test_stale_detection_when_manifest_tampered(manager):
    manager.generate([0, 1])
    manifest_path = manager.level_manifest_path(1)
    payload = json.loads(manifest_path.read_text())
    payload["config"]["tile_size"] = 64
    manifest_path.write_text(json.dumps(payload))
    status = manager.level_status(1)
    assert status.state is LevelState.STALE
    assert "configuration" in status.detail or "tile" in status.detail


def test_partial_level_reported_and_resumed(manager):
    manager.generate([0, 1])
    # Remove one tile and the level manifest to simulate an interruption.
    geom = manager.geometry(1)
    victim = manager.tile_path(1, 0, 0)
    victim.unlink()
    manager.level_manifest_path(1).unlink()
    status = manager.level_status(1)
    assert status.state is LevelState.PARTIAL
    assert status.tiles_present == geom.tile_count - 1
    assert "incomplete" in status.describe()

    # Regenerating only rewrites the missing tile and finalizes the level.
    written = manager.generate([1])
    assert written == [1]
    assert manager.level_status(1).state is LevelState.COMPLETE
    assert manager.compare_level(1).equal


def test_cancel_keeps_finished_tiles_and_resume_completes(manager):
    calls = {"n": 0}

    def should_cancel() -> bool:
        calls["n"] += 1
        return calls["n"] > 3

    with pytest.raises(CancelledError):
        manager.generate([0], should_cancel=should_cancel)
    status = manager.level_status(0)
    assert status.state is LevelState.PARTIAL
    assert 0 < status.tiles_present < status.tile_count

    manager.generate([0])
    assert manager.level_status(0).state is LevelState.COMPLETE
    assert manager.compare_level(0).equal


def test_progress_callback_reports_totals(manager):
    events = []
    manager.generate([0], progress=lambda d, t, m: events.append((d, t)))
    assert events[0][0] == 0
    total = manager.geometry(0).tile_count
    assert max(done for done, _ in events) == total
    assert all(t == total for _, t in events if t)


def test_different_content_same_name_gets_separate_tiles(tmp_path):
    from tests.conftest import write_png

    path = tmp_path / "same.png"
    array_a = np.zeros((40, 50, 3), np.uint8)
    array_b = np.full((40, 50, 3), 255, np.uint8)
    write_png(path, array_a)
    manager_a = CacheManager(
        tmp_path / "cache", load_source(path), CacheConfig(tile_size=16, margin=0)
    )
    manager_a.generate()
    write_png(path, array_b)
    manager_b = CacheManager(
        tmp_path / "cache", load_source(path), CacheConfig(tile_size=16, margin=0)
    )
    assert manager_a.directory != manager_b.directory
    assert manager_b.statuses()[0].state is LevelState.MISSING
    manager_b.generate([0])
    npt.assert_array_equal(
        manager_b.stitch_level(0), np.full((40, 50, 3), 255, np.uint8)
    )


def test_config_change_uses_different_directory(tmp_path, source_png):
    source = load_source(source_png)
    root = tmp_path / "cache"
    a = CacheManager(root, source, CacheConfig(tile_size=16, margin=0))
    b = CacheManager(root, source, CacheConfig(tile_size=16, margin=4))
    assert a.directory != b.directory


def test_force_rebuild_removes_tampered_tiles(manager):
    manager.generate([0])
    path = manager.tile_path(0, 0, 0)
    from PIL import Image

    Image.new("RGB", (16, 16), (1, 2, 3)).save(path)
    # Content no longer matches the manifest, so the level is not trusted.
    assert manager.level_status(0).state is LevelState.STALE
    manager.generate([0], force=True)
    assert manager.level_status(0).state is LevelState.COMPLETE
    assert manager.compare_level(0).equal


def test_generate_repairs_stale_level_without_force(manager):
    manager.generate([0])
    from PIL import Image

    Image.new("RGB", (16, 16), (9, 9, 9)).save(manager.tile_path(0, 0, 0))
    assert manager.level_status(0).state is LevelState.STALE
    manager.generate([0])
    assert manager.level_status(0).state is LevelState.COMPLETE
    assert manager.compare_level(0).equal


def test_pyramid_manifest_mismatch_is_detected(manager):
    manager.write_pyramid_manifest()
    assert manager.pyramid_manifest_ok()
    payload = json.loads(manager.manifest_path.read_text())
    payload["source_width"] += 1
    manager.manifest_path.write_text(json.dumps(payload))
    assert not manager.pyramid_manifest_ok()


def test_stitch_tiles_rejects_wrong_shapes():
    with pytest.raises(ValueError):
        stitch_tiles([(Rect(0, 0, 4, 4), np.zeros((3, 4, 3), np.uint8))], 4, 4)


def test_cache_format_version_is_recorded(manager):
    manager.generate([0])
    payload = json.loads(manager.level_manifest_path(0).read_text())
    assert payload["format"] == CACHE_FORMAT_VERSION
    assert payload["source_sha256"] == manager.source.sha256
    cores = [tuple(entry["core"]) for entry in payload["tiles"]]
    assert len(cores) == manager.geometry(0).tile_count


def test_sizes_parameter_overrides_pyramid(tmp_path, source_png):
    source = load_source(source_png)
    manager = CacheManager(
        tmp_path / "cache",
        source,
        CacheConfig(tile_size=16, margin=0),
        sizes=[(source.width, source.height)],
    )
    assert manager.info.level_count == 1
    assert manager.info.to_dict()["levels"][0]["cols"] == 4
