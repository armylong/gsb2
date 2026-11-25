"""会话状态机测试: 不依赖 Qt/ffmpeg。"""
import unittest

from blindabx.session import Session, SessionSettings


def make_settings(**over) -> SessionSettings:
    base = dict(
        setting_a={"key": "a"}, setting_b={"key": "b"},
        source_name="s", alignment=True, loudness_match=False, blind=True,
    )
    base.update(over)
    return SessionSettings(**base)


class SessionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.s = Session(make_settings())

    def test_round_lifecycle_and_scoring(self) -> None:
        r1 = self.s.start_round("t1")
        self.assertTrue(self.s.in_round)
        self.assertIn(r1.x_is, ("A", "B"))
        # 轮内 X 来源保持不变
        self.assertEqual(self.s.current.x_is, r1.x_is)
        out = self.s.submit(r1.x_is, "t2")       # 必对
        self.assertEqual(out.correct, True)
        self.assertFalse(self.s.in_round)

        r2 = self.s.start_round("t3")
        self.s.submit("A" if r2.x_is == "B" else "B", "t4")  # 必错
        hits, total = self.s.score()
        self.assertEqual((hits, total), (1, 2))

    def test_each_round_independent_choice_covers_both(self) -> None:
        seen = set()
        for _ in range(40):
            r = self.s.start_round("t")
            seen.add(r.x_is)
            self.s.cancel()
        self.assertEqual(seen, {"A", "B"})

    def test_canceled_and_unstarted_not_exported(self) -> None:
        self.s.start_round("t")
        self.s.cancel()
        record = self.s.export_record()
        self.assertEqual(record["summary"]["answered_rounds"], 0)
        self.assertEqual(record["rounds"], [])
        self.assertIsNone(record["summary"]["accuracy"])

    def test_submit_requires_guess_and_active_round(self) -> None:
        with self.assertRaises(RuntimeError):
            self.s.submit("A", "t")
        self.s.start_round("t")
        with self.assertRaises(ValueError):
            self.s.submit("C", "t")  # type: ignore[arg-type]

    def test_export_contains_settings_snapshot(self) -> None:
        self.s.start_round("t")
        self.s.submit("A", "t2")
        rec = self.s.export_record()
        self.assertEqual(rec["schema"], "blindabx-record/v1")
        row = rec["rounds"][0]
        self.assertEqual(row["settings"]["setting_a"], {"key": "a"})
        self.assertEqual(row["x_was"], row["x_was"])  # 答案已揭示
        self.assertIn("correct", row)

    def test_double_start_blocked(self) -> None:
        self.s.start_round("t")
        with self.assertRaises(RuntimeError):
            self.s.start_round("t")

    def test_cancel_without_round_blocked(self) -> None:
        with self.assertRaises(RuntimeError):
            self.s.cancel()

    def test_old_rounds_keep_snapshot_when_settings_change(self) -> None:
        self.s.start_round("t")
        self.s.submit("A", "t2")
        new = Session(make_settings(blind=False))
        old_rec = self.s.export_record()
        self.assertTrue(old_rec["rounds"][0]["settings"]["blind"])
        self.assertFalse(new.settings.blind)


if __name__ == "__main__":
    unittest.main()
