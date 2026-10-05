#!/usr/bin/env python3
"""Static contracts for how the panel fetches, caches and draws tides."""

import json
from pathlib import Path
import re
import unittest


PLUGIN = Path(__file__).parents[1]
PANEL = (PLUGIN / "Panel.qml").read_text(encoding="utf-8")
DAY = (PLUGIN / "DayDetail.qml").read_text(encoding="utf-8")
TIDES = (PLUGIN / "Tides.js").read_text(encoding="utf-8")
MANIFEST = json.loads((PLUGIN / "manifest.json").read_text(encoding="utf-8"))


def block(source, start, end):
    return source.split(start, 1)[1].split(end, 1)[0]


class TideWiringTests(unittest.TestCase):
    def test_settings_have_schema_entries_and_defaults(self):
        defaults = MANIFEST["barWidget"]["defaults"]
        self.assertIs(defaults["tidesEnabled"], True)
        self.assertEqual(defaults["tideMaxDistanceKm"], 40)
        self.assertEqual(defaults["tideStation"], "")
        schema = {entry["key"]: entry for entry in MANIFEST["barWidget"]["schema"]}
        self.assertEqual(schema["tidesEnabled"]["type"], "boolean")
        self.assertIs(schema["tidesEnabled"]["defaultValue"], True)
        self.assertEqual(schema["tideMaxDistanceKm"]["type"], "integer")
        self.assertEqual(schema["tideMaxDistanceKm"]["defaultValue"], 40)
        self.assertEqual(schema["tideStation"]["type"], "string")
        self.assertEqual(schema["tideStation"]["defaultValue"], "")

    def test_panel_reads_the_settings(self):
        for contract in (
            'setting("tidesEnabled", true) !== false',
            'setting("tideMaxDistanceKm", 40)',
            'setting("tideStation", "")',
            "Tides.chooseStation(",
        ):
            self.assertIn(contract, PANEL)

    def test_nothing_is_read_or_fetched_when_tides_are_off(self):
        index = block(PANEL, "id: tideIndexFile", "}\n")
        cache = block(PANEL, "id: tideCacheFile", "}\n")
        self.assertIn("root.tidesEnabled ?", index)
        self.assertIn("root.tidesEnabled ?", cache)
        ensure = block(PANEL, "function ensureTides()", "\n  }\n")
        self.assertIn("!tidesEnabled", ensure)
        self.assertIn("!tideChoice", ensure)

    def test_fetch_only_for_an_open_day_card(self):
        ensure = block(PANEL, "function ensureTides()", "\n  }\n")
        self.assertIn('detailSelection.kind !== "day"', ensure)
        self.assertEqual(PANEL.count("tideProc.running = true"), 1)
        self.assertIn("onDetailSelectionChanged: ensureTides()", PANEL)

    def test_request_goes_through_the_adapter_and_records_what_it_was_for(self):
        ensure = block(PANEL, "function ensureTides()", "\n  }\n")
        self.assertIn("Tides.PROVIDERS[", ensure)
        self.assertIn(".request(", ensure)
        self.assertIn("Tides.needsFetch(", ensure)
        self.assertIn("tideRequest = { key: tideKey", ensure)
        self.assertNotIn("curl", PANEL.split("function ensureTides()")[1].split("\n  }\n")[0])

    def test_response_is_dropped_unless_it_answers_the_current_station(self):
        done = block(PANEL, "function finishTideFetch(raw)", "\n  }\n")
        self.assertIn("Tides.isCurrent(asked, tideKey)", done)
        self.assertIn(".parse(raw)", done)
        self.assertIn("rejectOversized(raw", done)

    def test_cache_lives_in_the_state_directory_never_the_plugin(self):
        self.assertIn('"/.local/state/omarchy/detailed-weather-tides.json"', PANEL)
        writes = re.findall(r"(\w+)\.setText\(", PANEL)
        self.assertEqual([w for w in writes if w != "tideCacheFile"], [])
        self.assertIn("tideCacheFile.setText(", PANEL)
        self.assertIn("atomicWrites: true", block(PANEL, "id: tideCacheFile", "}\n"))

    def test_station_index_is_read_from_the_plugin_not_downloaded(self):
        self.assertIn('Qt.resolvedUrl("tide-stations.json")', PANEL)
        # No station-list endpoint: NOAA's metadata API, or DFO's bare /stations.
        self.assertNotIn("mdapi", TIDES)
        self.assertIsNone(re.search(r'v1/stations["?]', TIDES))

    def test_window_and_card_use_the_zoned_report(self):
        self.assertIn("Tides.windowFor(zonedReport)", PANEL)
        self.assertIn('Zone.localPath(Qt.resolvedUrl("tide-stations.json").toString())', PANEL)
        self.assertNotIn("function localPath", TIDES)

    def test_card_hands_the_tide_info_to_the_day_detail(self):
        self.assertIn("}, tideInfo)", PANEL)

    def test_tide_rows_are_columns_that_never_elide(self):
        table = block(DAY, "id: tideTable", "wrapMode: Text.WordWrap")
        for contract in ("modelData.label", "modelData.time", "modelData.height", "root.card.tides.rows"):
            self.assertIn(contract, table)
        self.assertNotIn("DetailRows", table)
        self.assertNotIn("elide", table)

    def test_day_card_draws_the_tides(self):
        for contract in ("root.card.tides", "root.card.tides.station", "root.card.tides.datum", "root.card.tides.credit"):
            self.assertIn(contract, DAY)
        self.assertNotIn("SLOT: tides", DAY)

    def test_no_place_is_hard_coded(self):
        for source in (TIDES, PANEL, DAY):
            for city in ("San Francisco", "Vancouver", "Seattle", "New York", "Halifax"):
                self.assertNotIn(city, source)


if __name__ == "__main__":
    unittest.main()
