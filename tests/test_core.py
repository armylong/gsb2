"""Tests for the subtitle reflow core (no GUI required)."""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from subtitle_tool.cuts import cuts_inside, move_event_off_cuts, split_at_cut
from subtitle_tool.examples import (
    CUTS_TXT,
    EN_SRT,
    ZH_SRT,
    build_example_project,
    example_paths,
)
from subtitle_tool.export import (
    ExportOptions,
    collect_unresolved,
    export_merged,
    merged_srt_text,
    verify_merged_file,
    verify_srt_against_project,
)
from subtitle_tool.model import Event, Project, Row
from subtitle_tool.pairing import (
    apply_all_suggestions,
    apply_suggestion,
    build_pairing_suggestions,
    overlapping_components,
)
from subtitle_tool.session import Session
from subtitle_tool.srt import (
    build_srt,
    ms_to_timestamp,
    parse_cut_list,
    parse_short,
    parse_srt,
    parse_timestamp,
)


class TimeCodeTests(unittest.TestCase):
    def test_roundtrip(self):
        for ms in (0, 1, 999, 1000, 61_234, 3_600_000, 7_000_123):
            self.assertEqual(parse_timestamp(ms_to_timestamp(ms)), ms)

    def test_short_forms(self):
        self.assertEqual(parse_short("12.5"), 12_500)
        self.assertEqual(parse_short("1:02.25"), 62_250)
        self.assertEqual(parse_short("00:00:21,000"), 21_000)
        self.assertEqual(parse_short("3"), 3_000)

    def test_bad_timestamp(self):
        with self.assertRaises(ValueError):
            parse_timestamp("not a time")


class SrtTests(unittest.TestCase):
    def test_parse_and_build(self):
        cues = parse_srt(EN_SRT)
        self.assertEqual(len(cues), 7)
        self.assertEqual(cues[0].start_ms, 500)
        self.assertEqual(cues[0].end_ms, 3200)
        rebuilt = build_srt(cues)
        self.assertEqual(len(parse_srt(rebuilt)), 7)

    def test_bom_and_crlf(self):
        text = "﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nhello\r\n\r\n"
        cues = parse_srt(text)
        self.assertEqual(len(cues), 1)
        self.assertEqual(cues[0].text, "hello")

    def test_missing_index(self):
        text = "00:00:01,000 --> 00:00:02,000\nhello\n"
        cues = parse_srt(text)
        self.assertEqual(cues[0].text, "hello")

    def test_multiline_text(self):
        text = "1\n00:00:01,000 --> 00:00:02,000\nline one\nline two\n"
        cues = parse_srt(text)
        self.assertEqual(cues[0].lines, ["line one", "line two"])

    def test_cut_list(self):
        cuts = parse_cut_list(
            "# header\n12.5\n00:00:21,000\n1:02.25\n"
            "0:00:27.5 --> 0:00:28.0\n\n"
        )
        self.assertEqual(cuts, [12_500, 21_000, 27_500, 62_250])
    def test_cut_header_ignored(self):
        self.assertEqual(parse_cut_list("scene cuts\n12\nabc\n"), [12_000])


class PairingTests(unittest.TestCase):
    def setUp(self):
        self.project = build_example_project()

    def test_suggestions_cover_example_cases(self):
        sugs = build_pairing_suggestions(self.project, "en")
        kinds = [s.kind for s in sugs]
        self.assertEqual(kinds.count("pair"), 5)
        self.assertEqual(kinds.count("split"), 1)
        self.assertEqual(kinds.count("missing"), 1)

    def test_split_component_boundaries(self):
        sugs = build_pairing_suggestions(self.project, "en")
        split = next(s for s in sugs if s.kind == "split")
        self.assertEqual(split.anchor_uids, ["en#6"])
        self.assertEqual(split.other_uids, ["zh#5", "zh#6"])

    def test_apply_pairs_and_missing(self):
        sugs = build_pairing_suggestions(self.project, "en")
        apply_all_suggestions(self.project, sugs)
        events = self.project.sorted_events()
        self.assertEqual(len(events), 8)
        missing = [e for e in events if any(r.missing for r in e.rows)]
        self.assertEqual(len(missing), 1)
        self.assertIn("signal you", missing[0].text_for("en"))
        self.assertEqual(missing[0].text_for("zh"), "")

    def test_split_text_distributed(self):
        sugs = build_pairing_suggestions(self.project, "en")
        split = next(s for s in sugs if s.kind == "split")
        ids = apply_suggestion(self.project, split)
        self.assertEqual(len(ids), 2)
        evs = [self.project.event_by_id(i) for i in ids]
        self.assertEqual(evs[0].split_group, evs[1].split_group)
        self.assertTrue(evs[0].split_group)
        self.assertEqual(evs[0].text_for("zh"), "继续走，")
        self.assertEqual(evs[1].text_for("zh"), "不管发生什么。")
        self.assertEqual(evs[0].text_for("en"), "Keep going,")
        self.assertEqual(evs[1].text_for("en"), "no matter what.")

    def test_boundary_offset_kept(self):
        sugs = build_pairing_suggestions(self.project, "en")
        apply_all_suggestions(self.project, sugs)
        ev = self.project.sorted_events()[0]
        # anchor timing wins: en#1 is 500..3200
        self.assertEqual((ev.start_ms, ev.end_ms), (500, 3200))

    def test_gap_link_does_not_chain_track(self):
        a = parse_srt(
            "1\n00:00:01,000 --> 00:00:02,000\none\n\n"
            "2\n00:00:04,000 --> 00:00:05,000\ntwo\n"
        )
        b = parse_srt(
            "1\n00:00:02,100 --> 00:00:03,000\n一\n\n"
            "2\n00:00:05,100 --> 00:00:06,000\n二\n"
        )
        p = Project(lang_order=["en", "zh"])
        from subtitle_tool.model import Track
        p.add_track(Track.from_srt("en", "", a))
        p.add_track(Track.from_srt("zh", "", b))
        comps = overlapping_components(p.tracks["en"].cues, p.tracks["zh"].cues)
        self.assertEqual(len(comps), 2)

    def test_skip_used_keeps_locked(self):
        session = Session(self.project)
        sugs = session.suggestions()
        first = sugs[0]
        ids = session.apply_suggestion(first, lock=True)
        self.assertTrue(ids)
        before = session.project.event_by_id(ids[0]).clone()
        session.rebuild_unlocked()
        after = session.project.event_by_id(ids[0])
        self.assertIsNotNone(after)
        self.assertTrue(after.locked)
        self.assertEqual(after.to_dict(), before.to_dict())
        origins = {r.origin for r in after.rows}
        for ev in session.project.events:
            if ev.eid == ids[0]:
                continue
            for row in ev.rows:
                self.assertNotIn(row.origin, origins - {""})


class ModelTests(unittest.TestCase):
    def _project(self):
        p = build_example_project()
        apply_all_suggestions(p, build_pairing_suggestions(p, "en"))
        return p

    def test_rows_at(self):
        p = self._project()
        rows = p.rows_at(5_000)
        self.assertEqual([r.lang for _, r in rows], ["en", "zh"])  # during cue 2

    def test_rows_at_gap(self):
        p = self._project()
        self.assertEqual(p.rows_at(11_500), [])

    def test_missing_translation_flagged(self):
        p = self._project()
        kinds = [i.kind for i in p.all_issues()]
        self.assertIn("missing_translation", kinds)

    def test_cross_cut_flagged(self):
        p = build_example_project()
        sugs = [s for s in build_pairing_suggestions(p, "en") if s.kind == "split"]
        apply_suggestion(p, sugs[0])
        kinds = [i.kind for i in p.all_issues()]
        self.assertIn("crosses_cut", kinds)

    def test_reading_speed_flag(self):
        p = Project(lang_order=["en", "zh"])
        p.ensure_language("en")
        p.ensure_language("zh")
        p.profiles["zh"].max_cps = 5.0
        ev = Event("ev1", 0, 1000, [Row("en", "hi"), Row("zh", "这是一段非常长的中文")])
        p.add_event(ev)
        kinds = [i.kind for i in p.check_event(ev)]
        self.assertIn("reading_speed", kinds)

    def test_line_count_budget(self):
        p = Project(lang_order=["en", "zh"])
        p.ensure_language("en")
        p.ensure_language("zh")
        p.profiles["en"].max_lines = 1
        p.total_lines_budget = 2
        ev = Event("ev1", 0, 3000,
                   [Row("en", "a\nb"), Row("zh", "甲\n乙")])
        p.add_event(ev)
        kinds = [i.kind for i in p.check_event(ev)]
        self.assertIn("too_many_lang_lines", kinds)
        self.assertIn("too_many_lines", kinds)

    def test_locked_event_rejects_time_change(self):
        p = self._project()
        ev = p.sorted_events()[0]
        ev.locked = True
        res = p.set_event_window(ev.eid, 0, 4000)
        self.assertFalse(res.applied)
        self.assertIn("锁定", res.error)

    def test_time_change_warns_and_requires_ack(self):
        p = self._project()
        ev = p.sorted_events()[0]
        nxt = p.sorted_events()[1]
        res = p.set_event_window(ev.eid, ev.start_ms, nxt.end_ms + 500)
        self.assertFalse(res.applied)
        self.assertTrue(any("挤住" in w for w in res.warnings))
        res2 = p.set_event_window(
            ev.eid, ev.start_ms, nxt.end_ms + 500, acknowledge=True
        )
        self.assertTrue(res2.applied)

    def test_move_across_cut_warns(self):
        p = self._project()
        ev = [e for e in p.sorted_events() if e.start_ms == 500][0]
        res = p.set_event_window(ev.eid, 500, 12_000)
        self.assertFalse(res.applied)
        self.assertTrue(any("切点" in w for w in res.warnings))

    def test_split_event_and_lock_preserves_others(self):
        p = self._project()
        ev = p.sorted_events()[0]
        other = p.sorted_events()[1]
        other.locked = True
        before = other.to_dict()
        new_id, err = p.split_event(ev.eid, 2000)
        self.assertFalse(err)
        self.assertIsNotNone(new_id)
        self.assertEqual(other.to_dict(), before)

    def test_unpair_restores_track_timing(self):
        p = self._project()
        ev = p.sorted_events()[0]
        ids = p.unpair_event(ev.eid)
        self.assertEqual(len(ids), 2)
        evs = [p.event_by_id(i) for i in ids]
        spans = sorted((e.start_ms, e.end_ms) for e in evs)
        self.assertEqual(spans, [(500, 3200), (900, 3500)])

    def test_edit_text_on_split_rows_keeps_rows(self):
        p = self._project()
        p.unpair_event(p.sorted_events()[0].eid)
        # rebuild a two-row event for one language
        ev = Event("evx", 0, 4000, [Row("en", "hello"), Row("zh", "甲，"), Row("zh", "乙。")])
        p.add_event(ev)
        p.set_event_text("evx", "zh", "甲改，乙也改。")
        rows = p.event_by_id("evx").rows_for("zh")
        self.assertEqual(len(rows), 2)
        self.assertEqual("".join(r.text for r in rows), "甲改，乙也改。")
        self.assertTrue(all(not r.missing for r in rows))

    def test_edit_text_to_blank_marks_missing(self):
        p = self._project()
        ev = p.sorted_events()[0]
        p.set_event_text(ev.eid, "zh", "   ")
        rows = ev.rows_for("zh")
        self.assertTrue(all(r.missing for r in rows))
        self.assertIn("missing_translation", [i.kind for i in p.check_event(ev)])

    def test_merge_events(self):
        p = self._project()
        a, b = p.sorted_events()[5], p.sorted_events()[6]
        merged = p.merge_events([b.eid, a.eid])
        self.assertIsNotNone(merged)
        self.assertEqual(merged.start_ms, min(a.start_ms, b.start_ms))
        self.assertEqual(len(merged.rows_for("en")), 2)

    def test_tidy_moves_unlocked_only(self):
        p = self._project()
        # add a deliberate overlap
        a, b = p.sorted_events()[0], p.sorted_events()[1]
        b.start_ms = a.end_ms - 100
        b.end_ms = b.start_ms + 1000
        p.sort_events()
        b.locked = True
        b_before = (b.start_ms, b.end_ms)
        result = p.tidy_timings(acknowledge=True)
        self.assertTrue(result.applied)
        self.assertEqual((b.start_ms, b.end_ms), b_before)

    def test_tidy_resolves_chain_of_overlaps(self):
        p = Project(lang_order=["en", "zh"])
        p.ensure_language("en")
        p.ensure_language("zh")
        p.min_gap_ms = 40
        p.add_event(Event("ev1", 0, 3000, [Row("en", "a"), Row("zh", "甲")]))
        p.add_event(Event("ev2", 2000, 5000, [Row("en", "b"), Row("zh", "乙")]))
        p.add_event(Event("ev3", 4000, 6000, [Row("en", "c"), Row("zh", "丙")]))
        result = p.tidy_timings(acknowledge=True)
        self.assertTrue(result.applied)
        spans = [(e.start_ms, e.end_ms) for e in p.sorted_events()]
        self.assertEqual(spans, [(0, 3000), (3040, 6040), (6080, 8080)])
        self.assertFalse(
            [i for i in p.all_issues() if i.kind in ("overlap_next", "gap_next")]
        )

    def test_tidy_keeps_split_group_contiguous(self):
        p = self._project()
        evs = [e for e in p.sorted_events() if e.split_group]
        self.assertEqual(len(evs), 2)
        # splitting run already touches; tidy must not insert a gap there
        p.tidy_timings(acknowledge=True)
        self.assertEqual(evs[0].end_ms, evs[1].start_ms)

    def test_json_roundtrip(self):
        p = self._project()
        p2 = Project.from_json(p.to_json())
        self.assertEqual(
            [e.to_dict() for e in p.sorted_events()],
            [e.to_dict() for e in p2.sorted_events()],
        )
        self.assertEqual(p.cuts, p2.cuts)
        self.assertEqual(p.next_id, p2.next_id)
        self.assertEqual(p.lang_order, p2.lang_order)


class CutHelperTests(unittest.TestCase):
    def test_cuts_inside(self):
        p = build_example_project()
        sugs = [s for s in build_pairing_suggestions(p, "en") if s.kind == "split"]
        apply_suggestion(p, sugs[0])
        ev = [e for e in p.sorted_events() if e.start_ms == 20_000][0]
        self.assertEqual(cuts_inside(p, ev), [21_000])

    def test_split_at_cut(self):
        p = build_example_project()
        sugs = [s for s in build_pairing_suggestions(p, "en") if s.kind == "split"]
        apply_suggestion(p, sugs[0])
        ev = [e for e in p.sorted_events() if e.start_ms == 20_000][0]
        new_id, err = split_at_cut(p, ev)
        self.assertFalse(err)
        self.assertIsNotNone(new_id)
        self.assertEqual(cuts_inside(p, ev), [])
        self.assertFalse(any(cuts_inside(p, e) for e in p.sorted_events()))

    def test_move_off_cuts_shift(self):
        p = build_example_project()
        sugs = [s for s in build_pairing_suggestions(p, "en") if s.kind == "split"]
        apply_suggestion(p, sugs[0])
        ev = [e for e in p.sorted_events() if e.start_ms == 20_000][0]
        ok, msg = move_event_off_cuts(p, ev, "shift")
        self.assertTrue(ok, msg)
        self.assertEqual(cuts_inside(p, ev), [])


class ExportVerifyTests(unittest.TestCase):
    def _session(self):
        s = Session()
        s.new_project("en", "zh")
        s.load_track("en", "en.srt", EN_SRT)
        s.load_track("zh", "zh.srt", ZH_SRT)
        s.set_cuts_text(CUTS_TXT)
        s.apply_suggestions(s.suggestions())
        return s

    def test_merged_export_and_verify(self):
        s = self._session()
        text = merged_srt_text(s.project)
        self.assertIn("暴风雨来之前，我们必须动身。", text)
        report = verify_srt_against_project(s.project, text)
        self.assertTrue(report.ok)
        self.assertEqual(report.matched, 8)

    def test_export_files_and_verify(self):
        s = self._session()
        with tempfile.TemporaryDirectory() as tmp:
            srt = os.path.join(tmp, "merged.srt")
            manifest = os.path.join(tmp, "merged.manifest.json")
            issues = os.path.join(tmp, "unresolved.json")
            export_merged(s.project, srt, manifest)
            self.assertTrue(os.path.exists(srt))
            report = verify_merged_file(s.project, srt)
            self.assertTrue(report.ok)
            from subtitle_tool.export import verify_against_manifest
            report2 = verify_against_manifest(s.project, srt, manifest)
            self.assertTrue(report2.ok)
            s.export_unresolved(issues, os.path.join(tmp, "unresolved.txt"))
            self.assertTrue(os.path.exists(issues))
            self.assertTrue(os.path.exists(os.path.join(tmp, "unresolved.txt")))
            data = json.load(open(issues, encoding="utf-8"))
            self.assertIn("counts", data)
            kinds = [i["kind"] for i in data["issues"]]
            self.assertIn("missing_translation", kinds)

    def test_verify_detects_tampering(self):
        s = self._session()
        text = merged_srt_text(s.project)
        tampered = text.replace("暴风雨来之前，我们必须动身。", "暴风雨来之前我们必须动身")
        tampered = tampered.replace("00:00:03,400", "00:00:03,500")
        report = verify_srt_against_project(s.project, tampered)
        self.assertFalse(report.ok)
        kinds = {i.kind for i in report.issues}
        self.assertIn("text", kinds)
        self.assertIn("start_time", kinds)

    def test_manifest_catches_reorder(self):
        s = self._session()
        with tempfile.TemporaryDirectory() as tmp:
            srt = os.path.join(tmp, "m.srt")
            manifest = os.path.join(tmp, "m.manifest.json")
            export_merged(s.project, srt, manifest)
            cues = parse_srt(open(srt, encoding="utf-8").read())
            # swap the bodies of two neighbouring entries while keeping the
            # file sorted by time
            cues[0].text, cues[1].text = cues[1].text, cues[0].text
            open(srt, "w", encoding="utf-8").write(build_srt(cues))
            from subtitle_tool.export import verify_against_manifest
            report = verify_against_manifest(s.project, srt, manifest)
            self.assertFalse(report.ok)
            self.assertIn("text", {i.kind for i in report.issues})

    def test_unresolved_mentions_missing_and_cut(self):
        s = self._session()
        report = collect_unresolved(s.project)
        text = "\n".join(report.lines)
        self.assertIn("missing_translation", text)
        self.assertIn("crosses_cut", text)

    def test_options_changed_layout_roundtrips(self):
        s = self._session()
        opts = ExportOptions(include_lang_labels=True)
        text = merged_srt_text(s.project, opts)
        report = verify_srt_against_project(s.project, text)
        self.assertTrue(report.ok)

    def test_example_files_exist_and_parse(self):
        paths = example_paths()
        for key in ("en", "zh", "cuts"):
            self.assertTrue(os.path.exists(paths[key]), paths[key])
        self.assertEqual(len(parse_srt(open(paths["en"], encoding="utf-8").read())), 7)
        self.assertEqual(len(parse_srt(open(paths["zh"], encoding="utf-8").read())), 7)
        self.assertEqual(len(parse_cut_list(open(paths["cuts"], encoding="utf-8").read())), 3)


class SessionTests(unittest.TestCase):
    def test_undo_redo(self):
        s = Session()
        s.new_project()
        s.load_track("en", "en.srt", EN_SRT)
        self.assertEqual(len(s.project.tracks), 1)
        self.assertTrue(s.undo())
        self.assertEqual(len(s.project.tracks), 0)
        self.assertTrue(s.redo())
        self.assertEqual(len(s.project.tracks), 1)

    def test_text_edit_burst_is_one_undo_step(self):
        p = build_example_project()
        s = Session(p)
        s.apply_suggestions(s.suggestions())
        eid = s.project.sorted_events()[0].eid
        before = s.project.event_by_id(eid).text_for("zh")
        count = len(s._undo)
        for text in ("第一个字", "第一个字改", "第一个字改好"):
            s.set_event_text(eid, "zh", text)
        self.assertEqual(len(s._undo), count + 1)
        s.end_text_edit_burst()
        s.undo()
        self.assertEqual(s.project.event_by_id(eid).text_for("zh"), before)

    def test_text_edit_keeps_timings_and_locks(self):
        p = build_example_project()
        s = Session(p)
        s.apply_suggestions(s.suggestions())
        events = s.project.sorted_events()
        ev = events[0]
        ev.locked = True
        window = (ev.start_ms, ev.end_ms)
        s.set_event_text(ev.eid, "zh", "改过的译文")
        self.assertEqual(ev.text_for("zh"), "改过的译文")
        self.assertEqual((ev.start_ms, ev.end_ms), window)

    def test_set_profile(self):
        p = build_example_project()
        s = Session(p)
        s.set_profile("zh", max_cps=6.0, max_lines=1)
        self.assertEqual(s.project.profiles["zh"].max_cps, 6.0)
        self.assertEqual(s.project.profiles["zh"].max_lines, 1)

    def test_project_save_load(self):
        p = build_example_project()
        s = Session(p)
        s.apply_suggestions(s.suggestions())
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "p.srf.json")
            s.save_project(path)
            text = open(path, encoding="utf-8").read()
            s2 = Session()
            s2.load_project(text)
            self.assertEqual(
                [e.to_dict() for e in s2.project.sorted_events()],
                [e.to_dict() for e in s.project.sorted_events()],
            )

    def test_manual_pair_and_split(self):
        s = Session(build_example_project())
        created = s.manual_pair("en", ["en#1"], "zh", ["zh#1"])
        self.assertEqual(len(created), 1)
        ev = s.project.event_by_id(created[0])
        self.assertEqual(ev.text_for("zh"), "暴风雨来之前，我们必须动身。")
        # one English cue against two Chinese cues -> two associated events
        created2 = s.manual_pair("en", ["en#6"], "zh", ["zh#5", "zh#6"])
        self.assertEqual(len(created2), 2)
        evs = [s.project.event_by_id(i) for i in created2]
        self.assertEqual(evs[0].split_group, evs[1].split_group)
        self.assertTrue(evs[0].split_group)

    def test_manual_mark_missing(self):
        s = Session(build_example_project())
        created = s.manual_pair("en", ["en#4"], "zh", [])
        self.assertEqual(len(created), 1)
        ev = s.project.event_by_id(created[0])
        self.assertEqual(ev.text_for("en"), "I'll signal you when the gate opens.")
        self.assertEqual(ev.text_for("zh"), "")
        kinds = [i.kind for i in s.project.check_event(ev)]
        self.assertIn("missing_translation", kinds)

    def test_manual_pair_empty(self):
        s = Session(build_example_project())
        self.assertEqual(s.manual_pair("en", [], "zh", []), [])
        self.assertFalse(s.can_undo())


if __name__ == "__main__":
    unittest.main()
