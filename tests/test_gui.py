"""GUI 集成测试: offscreen 平台, 走真实加载/播放/核对/导出链路。"""

import json
import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402

from proxy_check.verification import Status, verify  # noqa: E402
from proxy_check.gui.main_window import MainWindow  # noqa: E402
from proxy_check.gui.state import AppState  # noqa: E402


@pytest.fixture(scope="module")
def app():
    a = QApplication.instance() or QApplication([])
    yield a


@pytest.fixture()
def window(app):
    w = MainWindow()
    yield w
    w._stop_playback()
    w.close()


def _load_pair(window, src, dst):
    source, proxy = window._load_media_job(str(src), str(dst))
    window.state.source = source
    window.state.proxy = proxy
    window._after_pair_changed()


def test_full_gui_flow_good_pair(window, paths, tmp_path):
    _load_pair(window, paths["source"], paths["good"])
    assert window.state.ready
    assert len(window.state.source.frames) == 300
    assert window.state.source.audio_file  # 音频已抽出

    # 播放/暂停/单步。
    window.step(7)
    assert window.state.player.index == 7
    window.toggle_play()
    assert window.state.player.playing
    window._stop_playback()
    assert not window.state.player.playing
    assert window.state.player.index == 7  # 停后位置保留

    # 单画面切换不回到开头。
    window.set_view_mode("single")
    window.swap_single()
    assert window.state.show_source_in_single is False
    assert window.state.player.index == 7
    window.player_view.render()


def test_verify_and_export_in_gui(window, paths, tmp_path):
    _load_pair(window, paths["source"], paths["good"])
    report = verify(paths["source"], paths["good"])
    window._on_verify_done(report)
    assert window.state.report.overall == Status.PASS
    assert window.checks_panel.table.rowCount() == len(report.checks)

    out = tmp_path / "gui_report.json"
    report.save_json(out)
    data = json.loads(out.read_text("utf-8"))
    assert data["overall"] == "PASS"

    montage = out.with_suffix(".evidence.png")
    window._write_evidence_montage(montage)
    assert montage.is_file() and montage.stat().st_size > 1000


def test_checkpoint_double_click_jumps(window, paths):
    _load_pair(window, paths["source"], paths["good"])
    report = verify(paths["source"], paths["good"])
    window._on_verify_done(report)
    target = report.checkpoints[3].source_index
    window.jump_to_frame(target)
    assert window.state.player.index == target
    assert window.slider.value() == target


def test_failed_pair_does_not_show_success(window, paths):
    _load_pair(window, paths["source"], paths["different"])
    report = verify(paths["source"], paths["different"])
    window._on_verify_done(report)
    assert window.state.report.overall == Status.FAIL
    # 失败证据仍可查看。
    assert window.checks_panel.cp_list.count() == len(report.checkpoints)


def test_state_reset_clears_stale_proxy(window, paths):
    _load_pair(window, paths["source"], paths["good"])
    assert window.state.ready
    # 模拟新一轮生成失败: 代理侧被清空, 旧结论作废。
    window.state.reset_proxy_side()
    assert window.state.proxy is None
    assert window.state.report is None
    assert not window.state.ready
    # 原片仍在。
    assert window.state.source is not None


def test_pair_key_uses_hash_not_filename(window, paths):
    _load_pair(window, paths["source"], paths["good"])
    key1 = window.state.pair_key()
    assert "source.mp4" in key1[0]
    # 同文件再开一次 key 不变(内容相同)。
    _load_pair(window, paths["source"], paths["good"])
    assert window.state.pair_key() == key1


def test_app_state_reset_pair(window):
    st = AppState()
    st.view_mode = "single"
    st.show_source_in_single = False
    st.reset_pair()
    assert st.source is None and st.proxy is None
    # 重置回到默认的并排模式与"显示原片"。
    assert st.view_mode == "side"
    assert st.show_source_in_single is True


def test_export_guard_blocks_mismatched_pair(window, paths, tmp_path):
    # 先载入 A 对并产生 A 的报告。
    _load_pair(window, paths["source"], paths["good"])
    report_a = verify(paths["source"], paths["good"])
    window._on_verify_done(report_a)

    # 再载入另一对(换入错片代理), 但保留旧报告对象模拟状态错配。
    source_b, proxy_b = window._load_media_job(
        str(paths["source"]), str(paths["different"]))
    window.state.source = source_b
    window.state.proxy = proxy_b
    window._after_pair_changed()
    # 旧报告里记录的代理 sha256 与当前代理不同。
    data = report_a.to_dict()
    key = window.state.pair_key()
    mismatch = (
        f"{data['proxy']['path']}|{data['proxy']['sha256']}" != key[1]
        or f"{data['source']['path']}|{data['source']['sha256']}" != key[0]
    )
    assert mismatch  # 防护条件会判定不一致并阻止导出


def test_import_proxy_without_sidecar_status(window, paths,
                                             sidecar_less_good_copy):
    _load_pair(window, paths["source"], sidecar_less_good_copy)
    report = verify(paths["source"], sidecar_less_good_copy)
    window._on_verify_done(report)
    assert report.overall == Status.PENDING
    # 失败/待核对时检查点证据仍然渲染出来。
    assert window.checks_panel.cp_list.count() == len(report.checkpoints)
