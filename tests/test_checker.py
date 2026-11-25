from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np

from stencil_checker.core import (
    analyze_paper,
    apply_proposal,
    export_binary,
    generate_proposals,
    paper_from_gray,
    raster_bridge,
    undo_bridge,
    verify_export,
)
from stencil_checker.samples import all_samples, chain_sample, tight_sample


class CoreAnalysisTests(unittest.TestCase):
    def test_samples_have_expected_floating_blocks(self) -> None:
        chain = chain_sample()
        result = analyze_paper(paper_from_gray(chain.gray), thin_width=3)
        self.assertGreaterEqual(result.floating_count, 2)
        self.assertIn(1, result.frame_labels)
        self.assertGreaterEqual(len(result.thin_points), 1)
        self.assertLessEqual(result.thin_points[0].width_px, 3)

        tight = tight_sample()
        result = analyze_paper(paper_from_gray(tight.gray), thin_width=3)
        self.assertEqual(result.floating_count, 1)

    def test_raster_bridge_has_exact_cardinal_pixel_width(self) -> None:
        for width in range(1, 9):
            mask = raster_bridge((31, 41), 5, 15, 35, 15, width)
            rows = np.where(mask[:, 20])[0]
            self.assertEqual(len(rows), width, width)

            mask = raster_bridge((41, 31), 15, 5, 15, 35, width)
            cols = np.where(mask[20, :])[0]
            self.assertEqual(len(cols), width, width)

    def test_one_bridge_can_only_merge_islands_and_remain_floating(self) -> None:
        sample = chain_sample()
        paper = paper_from_gray(sample.gray)
        before = analyze_paper(paper)
        x, y = sample.select_xy
        source = before.label_at(x, y)
        self.assertTrue(before.is_floating(source))

        proposals = generate_proposals(
            paper,
            before.labels,
            before.frame_labels,
            source,
            width=6,
            direction="右",
        )
        island_plan = next(
            p for p in proposals if p.feasible and not p.reaches_frame and p.target_labels
        )
        merged_paper, bridge = apply_proposal(paper, island_plan)
        after = analyze_paper(merged_paper)

        merged_label = after.label_at(x, y)
        self.assertTrue(after.is_floating(merged_label))
        self.assertLess(after.floating_count, before.floating_count)

        undone = undo_bridge(merged_paper, bridge)
        undone_result = analyze_paper(undone)
        self.assertEqual(undone_result.floating_count, before.floating_count)
        np.testing.assert_array_equal(undone, paper)

        # The merged block can subsequently be connected to the frame.
        frame_plans = generate_proposals(
            merged_paper,
            after.labels,
            after.frame_labels,
            merged_label,
            width=6,
            direction="左",
        )
        frame_plan = next(p for p in frame_plans if p.feasible and p.reaches_frame)
        fixed_paper, _ = apply_proposal(merged_paper, frame_plan)
        fixed = analyze_paper(fixed_paper)
        self.assertIn(fixed.label_at(x, y), fixed.frame_labels)

    def test_tight_sample_rejects_wide_bridge_and_accepts_narrow(self) -> None:
        sample = tight_sample()
        paper = paper_from_gray(sample.gray)
        analysis = analyze_paper(paper)
        x, y = sample.select_xy
        source = analysis.label_at(x, y)

        wide = generate_proposals(
            paper,
            analysis.labels,
            analysis.frame_labels,
            source,
            width=8,
            protected=sample.protected,
            direction="左",
        )
        self.assertTrue(wide)
        self.assertTrue(any(not p.feasible and p.protected_hits > 0 for p in wide))
        self.assertFalse(any(p.feasible for p in wide))

        narrow = generate_proposals(
            paper,
            analysis.labels,
            analysis.frame_labels,
            source,
            width=3,
            protected=sample.protected,
            direction="左",
        )
        plan = next(p for p in narrow if p.feasible and p.reaches_frame)
        new_paper, _ = apply_proposal(paper, plan, sample.protected)

        # Protected cells retain their original False value.
        self.assertFalse(np.any(sample.protected & new_paper))
        after = analyze_paper(new_paper)
        self.assertIn(after.label_at(x, y), after.frame_labels)

    def test_export_can_be_independently_rechecked(self) -> None:
        sample = chain_sample()
        paper = paper_from_gray(sample.gray)
        before = analyze_paper(paper)

        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "exported.png"
            export_binary(path, paper, "black")
            reloaded = verify_export(path, "black")
            self.assertEqual(reloaded.floating_count, before.floating_count)
            self.assertEqual(reloaded.component_count, before.component_count)

            # Apply the island-island bridge, export, and verify one fewer
            # floating component from the file on disk.
            proposals = generate_proposals(
                paper,
                before.labels,
                before.frame_labels,
                before.label_at(*sample.select_xy),
                width=6,
                direction="右",
            )
            plan = next(p for p in proposals if p.feasible and not p.reaches_frame)
            merged, _ = apply_proposal(paper, plan)
            export_binary(path, merged, "black")
            verified = verify_export(path, "black")
            self.assertEqual(verified.floating_count, before.floating_count - 1)
            self.assertTrue(verified.floating_labels)


class GuiSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        from PySide6.QtWidgets import QApplication

        cls.app = QApplication.instance() or QApplication([])

    def test_window_samples_undo_export_and_zoom(self) -> None:
        from stencil_checker.gui import MainWindow

        win = MainWindow()
        win.load_sample(all_samples()[0])
        initial_floating = win.analysis.floating_count
        self.assertGreaterEqual(initial_floating, 2)

        # Select the right-direction island joining plan.
        win.direction_combo.setCurrentIndex(win.direction_combo.findData("右"))
        self.assertTrue(win.proposals)
        row = next(
            i
            for i, p in enumerate(win.proposals)
            if p.feasible and not p.reaches_frame and p.target_labels
        )
        win.proposal_list.setCurrentRow(row)
        proposal = win.proposals[row]
        bridge_mask_before = proposal.mask(win.paper.shape)
        win.apply_selected_proposal()

        self.assertEqual(len(win.undo_bridges), 1)
        self.assertEqual(win.analysis.floating_count, initial_floating - 1)
        merged_label = win.analysis.label_at(*win.selected_xy)
        self.assertTrue(win.analysis.is_floating(merged_label))

        # Zoom never changes the bridge's pixel mask or coordinates.
        win.view.scale(2.7, 2.7)
        bridge = win.undo_bridges[0]
        np.testing.assert_array_equal(bridge.mask(win.paper.shape), bridge_mask_before)
        self.assertEqual(bridge.width, 6)
        transform = win.view.transform()
        self.assertGreater(transform.m11(), 1.0)

        win.undo()
        self.assertEqual(win.analysis.floating_count, initial_floating)
        self.assertEqual(len(win.redo_bridges), 1)
        win.redo()
        self.assertEqual(win.analysis.floating_count, initial_floating - 1)

        with tempfile.TemporaryDirectory() as td:
            out = str(Path(td) / "gui_export.png")
            win.export_to_path(out)
            report = win.build_verification_report(out)
            self.assertIn("剩余悬空块", report)
            self.assertIn(str(initial_floating - 1), report)

    def test_tight_sample_gui_width_control(self) -> None:
        from stencil_checker.gui import MainWindow

        win = MainWindow()
        win.load_sample(all_samples()[1])
        self.assertEqual(win.width_spin.value(), 8)
        self.assertFalse(any(p.feasible for p in win.proposals))

        win.width_spin.setValue(3)
        win.direction_combo.setCurrentIndex(win.direction_combo.findData("左"))
        self.assertTrue(any(p.feasible and p.reaches_frame for p in win.proposals))


if __name__ == "__main__":
    unittest.main()
