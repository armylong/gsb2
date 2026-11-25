from __future__ import annotations

import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402

from subtitle_avoidance.coordinates import widget_to_source  # noqa: E402
from subtitle_avoidance.model import Cue, Obstacle, Placement, Rect  # noqa: E402
from subtitle_avoidance.planner import PlacementStore, PlacementPlanner  # noqa: E402
from subtitle_avoidance.srt import format_timestamp, parse_srt  # noqa: E402
from subtitle_avoidance.video_view import VideoView  # noqa: E402


class CoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def test_srt_parse_and_timestamp(self) -> None:
        content = """1
00:00:01,250 --> 00:00:03,500
第一行
第二行

2
00:00:04.000 --> 00:00:05.000
Hello
"""
        cues = parse_srt(content)
        self.assertEqual(2, len(cues))
        self.assertAlmostEqual(1.25, cues[0].start)
        self.assertIn("\n", cues[0].text)
        self.assertEqual("00:00:01,250", format_timestamp(1.25))

    def test_coordinate_mapping_is_resize_invariant(self) -> None:
        rect = Rect(120, 80, 300, 160)
        for w, h in ((900, 600), (1400, 500), (500, 500)):
            # 模拟把控件中显示的某点反算回源坐标；同一源矩形中心始终反算一致。
            scale = min(w / 1280, h / 720)
            dw, dh = 1280 * scale, 720 * scale
            dx, dy = (w - dw) / 2, (h - dh) / 2
            widget_x = dx + rect.center_x * scale
            widget_y = dy + rect.center_y * scale
            sx, sy = widget_to_source(widget_x, widget_y, w, h, 1280, 720)
            self.assertAlmostEqual(rect.center_x, sx, places=4)
            self.assertAlmostEqual(rect.center_y, sy, places=4)

    def test_actual_wrapping_limits_box_width(self) -> None:
        planner = PlacementPlanner(1280, 720)
        laid = planner.layouts.layout("这是一段非常长的中文字幕，" * 8)
        self.assertGreater(laid.line_count, 1)
        self.assertLessEqual(laid.box_w, 1280 * 0.92 + 1)
        self.assertTrue(all(w <= planner.layouts.max_text_width + 1 for w in laid.line_widths))

    def test_collision_gap_is_not_applied_twice(self) -> None:
        a = Rect(0, 0, 100, 40)
        # 水平间距 3px；gap=2 时仍应安全，gap=4 时才判碰。
        b = Rect(103, 0, 100, 40)
        self.assertFalse(a.intersects(b, gap=2))
        self.assertTrue(a.intersects(b, gap=4))

    def test_obstacle_only_active_mid_cue_still_blocks_slot(self) -> None:
        planner = PlacementPlanner(1280, 720)
        cue = Cue("cue_1", 1, 0.0, 10.0, "短字幕")
        _, boxes = planner.candidate_boxes(cue.text)
        target = boxes["bottom_1"]
        obstacle = Obstacle(
            "o1", "中途题板", target.inflated(4), start=4.0, end=6.0
        )
        placement = planner.plan_cue(cue, [obstacle])
        self.assertNotEqual("bottom_1", placement.slot_id)
        self.assertIn("o1", placement.checked_obstacle_ids)
        self.assertTrue(placement.safe)

    def test_previous_safe_slot_is_preferred(self) -> None:
        planner = PlacementPlanner(1280, 720)
        first = Cue("c1", 1, 0, 2, "第一条")
        second = Cue("c2", 2, 2, 4, "第二条")
        prev = planner.plan_cue(first, [])
        # 人为把上一条安全位设成 bottom_2，验证偏好而不是默认 bottom_1。
        _, boxes = planner.candidate_boxes(first.text)
        prev = type(prev)(
            cue_id=prev.cue_id,
            slot_id="bottom_2",
            box=boxes["bottom_2"],
            safe=True,
        )
        current = planner.plan_cue(second, [], prev)
        self.assertEqual("bottom_2", current.slot_id)

    def test_unsafe_previous_placement_is_not_used_as_preference(self) -> None:
        planner = PlacementPlanner(1280, 720)
        current = Cue("c2", 2, 2, 4, "第二条")
        _, boxes = planner.candidate_boxes("第一条")
        bad_prev = Placement(
            cue_id="c1",
            slot_id="bottom_2",
            box=boxes["bottom_2"],
            safe=False,
            collisions=("o1",),
        )
        placement = planner.plan_cue(current, [], bad_prev)
        self.assertEqual("bottom_1", placement.slot_id)

    def test_all_candidates_fail_creates_marker(self) -> None:
        cues = [Cue("c1", 1, 1.0, 4.0, "无处可放的字幕")]
        obstacles = [Obstacle("big", "满屏禁区", Rect(0, 0, 1280, 720), 1.5, 3.5)]
        store = PlacementStore(1280, 720, cues, obstacles)
        store.rebuild()
        self.assertFalse(store.placements["c1"].safe)
        issues = store.issues()
        self.assertEqual(1, len(issues))
        self.assertIn(1.0, issues[0].marker_times)
        self.assertIn(1.5, issues[0].marker_times)

        store.manual_positions["c1"] = {"x": 100, "y": 300}
        store.rebuild()
        self.assertEqual(0, len(store.issues()))
        self.assertTrue(store.placements["c1"].manual)

    def test_text_edit_propagates_only_until_result_stable(self) -> None:
        cues = [
            Cue("c1", 1, 0, 2, "第一句"),
            Cue("c2", 2, 2, 4, "第二句"),
            Cue("c3", 3, 4, 6, "第三句"),
        ]
        store = PlacementStore(1280, 720, cues, [])
        store.rebuild()

        # 把第一句改成两行；它自己的字框改变，但第二、三句的位置结果不变。
        cues[0].text = "这是一句被明显加长、会换成两行的字幕内容，用于验证增量传播提前停止。"
        outcome = store.cue_text_edited("c1")
        self.assertEqual(["c1"], outcome.changed_ids)
        self.assertEqual(["c1", "c2"], outcome.recomputed_ids)
        self.assertEqual("bottom_1", store.placements["c2"].slot_id)

    def test_overlapping_cues_are_all_visible_with_latest_on_top(self) -> None:
        view = VideoView()
        try:
            view.cues = [
                Cue("a", 1, 0.0, 5.0, "前一条"),
                Cue("b", 2, 1.0, 6.0, "后一条"),
            ]
            view.current_cue_id = None
            view.time = 2.0
            self.assertEqual(["a", "b"], [c.id for c in view._visible_cues()])
            self.assertEqual("b", view._current_cue().id)

            view.current_cue_id = "a"
            view.time = 5.5
            self.assertEqual(["a"], [c.id for c in view._visible_cues()])
        finally:
            view.close()

    def test_candidate_moments_include_mid_cue_obstacle_start(self) -> None:
        cues = [Cue("c1", 1, 0, 10, "字幕")]
        obstacles = [Obstacle("o1", "o", Rect(0, 600, 1280, 120), 4.0, 6.0)]
        planner = PlacementPlanner(1280, 720)
        moments = planner.candidate_change_moments(cues, obstacles, 10.0)
        times = [round(m.time, 3) for m in moments]
        self.assertIn(4.0, times)
        self.assertIn(6.0, times)


if __name__ == "__main__":
    unittest.main()
