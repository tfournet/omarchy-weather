#!/usr/bin/env python3
"""Static contracts for the moon-illumination curve behind the ten-day strip."""

from pathlib import Path
import re
import unittest


PLUGIN = Path(__file__).parents[1]
PANEL = (PLUGIN / "Panel.qml").read_text(encoding="utf-8")


def canvas():
    return PANEL.split("id: moonCurve", 1)[1].split("\n              }\n", 1)[0]


class MoonCurveTests(unittest.TestCase):
    def test_one_canvas_exists_in_the_compact_strip_only(self):
        self.assertEqual(PANEL.count("id: moonCurve"), 1)
        strip = PANEL.split("id: forecastStrip", 1)[1].split("// ---- HOURLY", 1)[0]
        self.assertIn("id: moonCurve", strip)
        self.assertIn("Canvas {", strip)

    def test_it_draws_from_the_pure_functions_and_the_cached_illumination(self):
        body = canvas()
        self.assertIn("Moon.curvePoints(", body)
        self.assertIn("Moon.curveSegments(", body)
        self.assertIn("bezierCurveTo(", body)
        self.assertIn("Moon.illuminationSeries(zonedReport,", PANEL)

    def test_it_sits_behind_the_cells_without_taking_layout_space(self):
        body = canvas()
        self.assertNotIn("Layout.", body)
        self.assertIn("z: -1", body)
        self.assertIn("anchors.fill: parent", body)
        # A sibling of the row, in an Item that has the row's height.
        strip = PANEL.split("id: forecastStrip", 1)[1].split("// ---- HOURLY", 1)[0]
        item = strip.split("Item {", 1)[1]
        self.assertLess(item.index("id: moonCurve"), item.index("id: moonStripRow"))
        self.assertIn("height: root.metricCellHeight + Style.space(64)", item.split("id: moonCurve")[0])

    def test_it_is_thin_and_faint(self):
        body = canvas()
        self.assertRegex(body, r"lineWidth = 1(\.\d)?\b")
        self.assertRegex(body, r"Util\.alpha\([^)]*, 0\.[1-4]\d?\)")

    def test_it_repaints_only_when_its_inputs_change(self):
        body = canvas()
        for handler in ("onSeriesChanged", "onStrokeChanged", "onWidthChanged", "onHeightChanged"):
            self.assertIn(handler + ": requestPaint()", body)
        for banned in ("Timer", "NumberAnimation", "FrameAnimation", "running", "Behavior", "onPaint: requestPaint"):
            self.assertNotIn(banned, body)
        paint = body.split("onPaint:", 1)[1]
        self.assertNotIn("requestPaint", paint)
        # Only these four handlers ever ask for a paint.
        self.assertEqual(len(re.findall(r"requestPaint\(\)", body)), 4)

    def test_the_spacing_matches_the_row_so_points_sit_at_cell_centres(self):
        strip = PANEL.split("id: forecastStrip", 1)[1].split("// ---- HOURLY", 1)[0]
        self.assertIn("spacing: Style.space(6)", strip)
        self.assertIn("Moon.curvePoints(series, width, height, Style.space(6),", canvas())


if __name__ == "__main__":
    unittest.main()
