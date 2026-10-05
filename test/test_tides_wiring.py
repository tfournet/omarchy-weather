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
    def test_one_tides_setting_with_three_values(self):
        defaults = MANIFEST["barWidget"]["defaults"]
        self.assertEqual(defaults["tides"], "auto")
        schema = {entry["key"]: entry for entry in MANIFEST["barWidget"]["schema"]}
        self.assertEqual(schema["tides"]["type"], "enum")
        self.assertEqual(schema["tides"]["options"], ["auto", "on", "off"])
        self.assertEqual(schema["tides"]["defaultValue"], "auto")
        self.assertIn("100", schema["tides"]["description"])

    def test_the_old_tide_settings_are_gone_everywhere(self):
        for key in ("tidesEnabled", "tideMaxDistanceKm", "tideStation", "tideMaxKm", "tideOverride",
                    "tideRanges", "saveTideStation", "parseOverride", "chooseStation"):
            for name, source in (("manifest", json.dumps(MANIFEST)), ("Panel", PANEL), ("Tides", TIDES),
                                 ("README", (PLUGIN / "README.md").read_text(encoding="utf-8"))):
                self.assertIsNone(re.search(r"\b" + key + r"\b", source), name + " still mentions " + key)

    def test_the_threshold_is_a_named_constant_not_a_setting(self):
        self.assertIn("var AUTO_MAX_KM = 100", TIDES)
        self.assertNotIn("100", PANEL.split("tidesMode")[1].split("function ensureTides()")[0].replace("tide-stations", ""))

    def test_the_panels_own_settings_view_uses_its_choice_control(self):
        settings = PANEL.split("id: settingsColumn")[1]
        section = block(settings, 'text: "TIDES"', 'text: "ALERTS"')
        for contract in (
            '{ id: "auto", label: "Auto" }',
            '{ id: "on", label: "On" }',
            '{ id: "off", label: "Off" }',
            'root.tidesMode === modelData.id',
            'root.persistSetting("tides", modelData.id)',
            "Rectangle {",
            "MouseArea {",
        ):
            self.assertIn(contract, section)
        self.assertNotIn("TextField", section)
        self.assertNotIn("ToggleSwitch", section)
        # It explains what auto does, with the distance, so the choice is informed.
        self.assertIn("100 km", section)
        self.assertLess(settings.index('text: "TIDES"'), settings.index('text: "ALERTS"'))

    def test_panel_reads_the_one_setting(self):
        for contract in (
            'Tides.normalizeMode(setting("tides", "auto"))',
            "Tides.stationFor(",
        ):
            self.assertIn(contract, PANEL)

    def test_the_card_names_the_station_and_distance(self):
        self.assertIn("root.card.tides.station", DAY)

    def test_nothing_is_read_or_fetched_when_off_or_out_of_range(self):
        index = block(PANEL, "id: tideIndexFile", "}\n")
        cache = block(PANEL, "id: tideCacheFile", "}\n")
        # The station index is only needed to look a station up, so not when off.
        self.assertIn('root.tidesMode !== "off" ?', index)
        # The cache is only read once there is a station to show.
        self.assertIn("root.tideChoice ?", cache)
        ensure = block(PANEL, "function ensureTides()", "\n  }\n")
        self.assertIn("!tideChoice", ensure)
        # No station means no tide UI: the card gets no tide info.
        self.assertIn("readonly property var tideInfo: tideChoice", PANEL)

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

    def test_the_wave_is_one_canvas_behind_the_hourly_cells(self):
        self.assertEqual(PANEL.count("id: tideWaveCanvas"), 1)
        strip = PANEL.split("id: hourlyStrip", 1)[1].split("// ---- METRICS", 1)[0]
        self.assertIn("id: tideWaveCanvas", strip)
        body = self.wave_canvas()
        for contract in ("z: -1", "visible: root.tideWave !== null", "Tides.waveLayout(wave,", "arc("):
            self.assertIn(contract, body)

    def wave_canvas(self):
        return PANEL.split("id: tideWaveCanvas", 1)[1].split("\n              }\n", 1)[0]

    def test_the_wave_repaints_only_when_its_inputs_change(self):
        body = self.wave_canvas()
        for handler in ("onWaveChanged", "onStrokeChanged", "onWidthChanged", "onHeightChanged"):
            self.assertIn(handler + ": requestPaint()", body)
        self.assertEqual(len(re.findall(r"requestPaint\(\)", body)), 4)
        for banned in ("Timer", "NumberAnimation", "FrameAnimation", "running", "Behavior"):
            self.assertNotIn(banned, body)
        self.assertNotIn("requestPaint", body.split("onPaint:", 1)[1])

    def test_the_wave_does_no_work_and_asks_for_nothing_when_tides_are_inactive(self):
        wave = block(PANEL, "readonly property var tideWave:", "\n\n")
        # Guarded by the same station the card uses, and only cached events.
        self.assertIn("tideInfo", wave)
        self.assertIn("tideInfo.events", wave)
        self.assertIn("Tides.wave(", wave)
        self.assertIn("Tides.hourEpochs(dailyForecastReport, hourly)", wave)
        self.assertIn(": null", wave)
        # Still exactly one place that starts a request: the day card's.
        self.assertEqual(PANEL.count("tideProc.running = true"), 1)

    def test_no_place_is_hard_coded(self):
        for source in (TIDES, PANEL, DAY):
            for city in ("San Francisco", "Vancouver", "Seattle", "New York", "Halifax"):
                self.assertNotIn(city, source)


if __name__ == "__main__":
    unittest.main()
