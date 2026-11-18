from __future__ import annotations

import numpy as np
import pytest


@pytest.fixture(scope="session")
def qapp():
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance() or QApplication([])
    return app


def test_step_grid_cycle_includes_empty_and_repeats(qapp):
    from drumchopper.audio import Sequence
    from drumchopper.ui.sequencer import StepGrid

    grid = StepGrid()
    seq = Sequence()
    grid.set_state(seq, 3, [0] * 16, 44100)
    assert seq.steps[0] is None
    grid.cycle_step(0, +1)
    assert seq.steps[0] == 0
    grid.cycle_step(0, +1)
    assert seq.steps[0] == 1
    grid.cycle_step(0, +1)
    assert seq.steps[0] == 2
    grid.cycle_step(0, +1)
    assert seq.steps[0] is None, "越过最后一片应回到空格"
    grid.cycle_step(0, -1)
    assert seq.steps[0] == 2, "反向也应可用"


def test_slice_panel_edits_keep_partition_valid(qapp):
    from drumchopper.audio import SliceModel, SourceAudio
    from drumchopper.ui.sequencer import SlicePanel

    data = np.zeros(4000, dtype=np.float32)
    src = SourceAudio(samples=data, samplerate=1000)
    model = SliceModel(src.frames)
    model.set_cuts([1000, 2000, 3000])
    panel = SlicePanel()
    panel.set_state(src, model, 1)
    # extend the start of slice 2 into the previous slice without inverting
    panel.start_spin.setValue(3500)
    panel._apply_spins()
    bounds = model.slice_bounds()
    assert bounds[1] == (3500, 2000) or bounds[1][0] < bounds[1][1]
    assert all(e > s for s, e in bounds)
    # now try to push the end past the next cut
    panel.set_state(src, model, 0)
    panel.end_spin.setValue(3900)
    panel._apply_spins()
    bounds = model.slice_bounds()
    assert all(e > s for s, e in bounds)
    assert bounds[0][1] == bounds[1][0]


def test_layer_panel_last_slice_end_is_read_only(qapp):
    from drumchopper.audio import SliceModel, SourceAudio
    from drumchopper.ui.sequencer import SlicePanel

    src = SourceAudio(samples=np.zeros(500, dtype=np.float32), samplerate=1000)
    model = SliceModel(src.frames)
    model.set_cuts([200])
    panel = SlicePanel()
    panel.set_state(src, model, 1)
    assert not panel.end_spin.isEnabled(), "最后一片固定到素材末尾"


def test_waveform_adds_and_removes_cuts(qapp):
    from drumchopper.audio import SliceModel, SourceAudio
    from drumchopper.ui.waveform import WaveformWidget

    src = SourceAudio(samples=np.zeros(4000, dtype=np.float32), samplerate=1000)
    model = SliceModel(src.frames)
    widget = WaveformWidget()
    widget.resize(800, 300)
    widget.set_source(src, model)
    assert model.add_cut(1234)
    assert model.cuts == [1234]
    model.remove_cut(0)
    assert model.cuts == []
