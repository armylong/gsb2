import json

from PySide6.QtWidgets import QApplication

from audio_integrity.app import MainWindow
from audio_integrity.export import export_json


def test_main_window_smoke_confirm_reanalyze_and_export(tmp_path):
    app = QApplication.instance() or QApplication([])
    win = MainWindow()
    app.processEvents()

    assert win.audio is not None
    assert win.result is not None
    assert win.table.rowCount() > 0

    # Rendering every custom plot should not raise in offscreen mode.
    win.wave.grab()
    win.heatmap.grab()
    win.relation.grab()

    first_id = win.table.item(0, 0).data(0x0100)  # Qt.UserRole
    win.select_annotation(first_id)
    assert win._selected_annotation() is not None
    win.confirm_selected()
    ann = win._selected_annotation()
    assert ann.status == "confirmed"

    # Full-band and selected-band listening must use identical time bounds.
    play_calls = []
    win.playback.play_interval = lambda *args, **kwargs: play_calls.append((args, kwargs))
    win.play_full()
    win.play_band()
    assert len(play_calls) == 2
    full_args, full_kwargs = play_calls[0]
    band_args, band_kwargs = play_calls[1]
    assert full_args[1:3] == band_args[1:3] == (ann.start, ann.end)
    assert full_kwargs["band"] is None
    assert band_kwargs["band"] is not None

    # Changing a threshold reruns analysis but preserves the human confirmation.
    win.spin_band.setValue(win.spin_band.value() + 2.0)
    app.processEvents()
    win._reanalyze()
    assert any(a.id == ann.id and a.status == "confirmed" for a in win.annotations)

    out = tmp_path / "confirmed.json"
    export_json(
        out,
        win.annotations,
        audio_path=win.audio.path,
        sample_rate=win.audio.sample_rate,
        n_channels=win.audio.n_channels,
        duration=win.audio.duration,
    )
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["count"] >= 1
    assert payload["annotations"][0]["status"] == "confirmed"
    win.close()
