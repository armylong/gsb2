from __future__ import annotations

from pathlib import Path

import numpy as np

from lighttrails.engine import (
    LockRegion,
    StackParams,
    roi_contributors,
    stack_sequence,
)
from lighttrails.export import export_frame_list
from lighttrails.sequence import FrameItem, detect_missing_gaps, make_frame_items, natural_key
from lighttrails.synth import sample_frames


def test_natural_sort_and_single_missing_gap(tmp_path: Path) -> None:
    names = ["img_1.png", "img_2.png", "img_4.png", "img_10.png"]
    paths = [tmp_path / name for name in names]
    items = make_frame_items(paths)

    assert [item.file_name for item in items] == names
    assert [item.original_index for item in items] == [1, 2, 3, 4]
    assert [item.source_number for item in items] == [1, 2, 4, 10]

    gaps = detect_missing_gaps(items)
    single = [gap for gap in gaps if gap.single]
    assert len(single) == 1
    assert single[0].missing_number == 3
    assert single[0].left_index == 2
    assert single[0].right_index == 3
    assert "img_2.png" in single[0].describe()
    assert "img_4.png" in single[0].describe()


def test_natural_sort_handles_mixed_name_shapes() -> None:
    paths = ["10.png", "1.png", "a.png", "a1.png", "1a.png", "img2.png", "img10.png"]
    ordered = [p.name for p in sorted((Path(p) for p in paths), key=natural_key)]
    assert set(ordered) == set(paths)
    assert ordered.index("img2.png") < ordered.index("img10.png")
    assert ordered.index("1.png") < ordered.index("10.png")


def test_manual_exclusion_does_not_renumber() -> None:
    items = make_frame_items([f"shot_{i:03d}.jpg" for i in range(1, 6)])
    items[2].excluded = True  # original sequence 003

    assert [item.original_index for item in items] == [1, 2, 3, 4, 5]
    assert [item.display_number() for item in items] == ["001", "002", "003", "004", "005"]
    assert items[2].excluded is True


def _moving_point_sequence() -> list[np.ndarray]:
    frames = []
    for i in range(12):
        arr = np.full((24, 32, 3), 18, dtype=np.uint8)
        x = 3 + i
        y = 12
        arr[y - 1 : y + 2, x - 1 : x + 2] = 235
        # A one-frame isolated strong spot/reflection far from the trajectory.
        if i == 6:
            arr[2:5, 25:28] = 255
        frames.append(arr)
    return frames


def test_continuous_trail_kept_isolated_spot_removed_and_lock_overrides() -> None:
    frames = _moving_point_sequence()
    params = StackParams(
        method="brighten",
        lum_threshold=60,
        excess_threshold=25,
        motion_radius=2,
        min_component_area=6,
        anti_flash=False,
    )
    result = stack_sequence(frames, params)

    # Every moving point position contributed at least its centre pixel.
    # Adjacent 3×3 footprints overlap; the single-valued source map may mark
    # any equally bright adjacent frame, while ROI analysis lists all of them.
    for i in range(12):
        x = 3 + i
        assert result.retained_mask[12, x]
        assert int(result.source_map[12, x]) in {i, i + 1, i + 2}

    # Isolated one-frame spot is not part of the stack.
    assert not result.retained_mask[3, 26]
    assert result.source_map[3, 26] == -1

    locked = stack_sequence(frames, params, locks=[LockRegion(24, 1, 5, 5)])
    assert locked.retained_mask[3, 26]
    assert locked.lock_mask[3, 26]


def test_minimum_dark_base_is_not_raised_by_single_flash() -> None:
    frames = []
    for i in range(7):
        arr = np.full((20, 20, 3), 22, dtype=np.uint8)
        arr[10, 2 + i] = 240
        if i == 4:
            arr[4:16, 4:16] = np.clip(arr[4:16, 4:16].astype(np.int16) + 120, 0, 255)
        frames.append(arr)

    result = stack_sequence(
        frames,
        StackParams(lum_threshold=80, excess_threshold=30, motion_radius=2, min_component_area=3),
    )
    assert np.all(result.baseline == 22)
    # Flash frame is identified even though it is original index 5.
    assert 5 in result.flash_indices
    assert not result.retained_mask[10, 10] or result.source_map[10, 10] != 5


def test_sample_retains_trail_and_rejects_flash_core_in_both_methods() -> None:
    frames = sample_frames()
    indices = list(range(1, len(frames) + 1))

    for method in ("brighten", "count"):
        params = StackParams(method=method)
        if method == "brighten":
            params.min_occurrences = 1
        result = stack_sequence(frames, params, original_indices=indices)

        assert result.image.shape == frames[0].shape
        assert result.source_map.shape[:2] == frames[0].shape[:2]
        assert 10 in result.flash_indices

        # Broad path through the middle-left is retained.
        assert int(result.retained_mask[120:170, 45:290].sum()) > 500
        # The sharp flash core at about (350, 189) is rejected, and no output
        # pixel is sourced from the detected one-frame reflection.
        assert 10 not in set(np.unique(result.source_map).tolist())
        assert int(result.retained_mask[184:198, 340:366].sum()) == 0
        # One-pixel static hot pixels are removed.
        assert not result.retained_mask[38, 42]


def test_roi_contributors_follow_frame_range_and_exclusion() -> None:
    frames = sample_frames()
    all_params = StackParams(method="brighten", start=1, end=36)
    all_contribs = roi_contributors(frames, all_params, (120, 110, 170, 70))
    all_retained = [c.original_index for c in all_contribs if c.retained_pixels > 0]
    assert len(all_retained) >= 5

    ranged_params = StackParams(method="brighten", start=8, end=14, excluded={10})
    ranged = roi_contributors(frames, ranged_params, (120, 110, 170, 70))
    active = [c.original_index for c in ranged if c.included]
    assert min(active) == 8
    assert max(active) == 14
    assert 10 not in active
    assert all(not c.included for c in ranged if c.original_index < 8 or c.original_index > 14)


def test_export_frame_list_contains_only_participants_by_default(tmp_path: Path) -> None:
    items = [
        FrameItem(original_index=1, path=tmp_path / "a_001.png", source_number=1, width=4, height=4),
        FrameItem(original_index=2, path=tmp_path / "a_003.png", source_number=3, width=4, height=4, excluded=True),
    ]
    params = StackParams(start=1, end=2, excluded={2})
    target = export_frame_list(tmp_path / "frames.csv", items, params)
    text = target.read_text(encoding="utf-8-sig")
    assert "original_index" in text
    assert "a_001.png" in text
    assert "a_003.png" not in text

    audit = export_frame_list(tmp_path / "all.csv", items, params, include_all=True)
    audit_text = audit.read_text(encoding="utf-8-sig")
    assert "a_003.png" in audit_text
    lines = audit_text.strip().splitlines()
    assert lines[2].split(",")[5] == "0"
