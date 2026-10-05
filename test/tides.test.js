// Tides: provider adapters, the shipped station index, nearest-station choice,
// the once-a-day cache, and the day rows. Fixtures are real responses fetched
// 2026-10-05 and trimmed:
//   noaa-9414290-gmt.json      San Francisco, time_zone=gmt, units=metric
//   noaa-9414290-lst_ldt.json  the same station asked in its own local time,
//                              which is the reference for the zone conversion
//   noaa-error.json            what NOAA answers (HTTP 200) for a bad station
//   dfo-07735-wlp-hilo.json    Vancouver, DFO IWLS wlp-hilo (events only: the
//                              API does not say which are highs)

const { test } = require("node:test")
const assert = require("node:assert/strict")
const { readFileSync, statSync } = require("node:fs")
const { join } = require("node:path")
const { loadLibrary } = require("./load.js")

const Tides = loadLibrary("Tides.js")
const Detail = loadLibrary("Detail.js")

const fixture = name => readFileSync(join(__dirname, "fixtures", name), "utf8")
const INDEX_PATH = join(__dirname, "..", "tide-stations.json")
const realIndex = () => Tides.parseIndex(readFileSync(INDEX_PATH, "utf8"))

const PDT = -7 * 3600
const SF = { provider: "noaa", id: "9414290", name: "San Francisco", lat: 37.806, lon: -122.465 }
const VANCOUVER = { provider: "dfo", id: "5cebf1de3d0f4a073c4bb943", name: "Vancouver", lat: 49.286, lon: -123.1 }

// ---- requests -----------------------------------------------------------

test("NOAA request is a curl argv with a fixed https base, a size cap and a timeout", () => {
  const from = Date.UTC(2026, 9, 4)
  const to = Date.UTC(2026, 9, 16)
  const argv = Tides.PROVIDERS.noaa.request("9414290", from, to)
  assert.ok(Array.isArray(argv) && argv.every(a => typeof a === "string"))
  assert.equal(argv[0], "curl")
  assert.ok(argv.includes("--max-filesize"))
  assert.ok(argv.includes("--max-time"))
  const url = argv[argv.length - 1]
  assert.ok(url.startsWith("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?"), url)
  for (const part of ["product=predictions", "station=9414290", "begin_date=20261004", "end_date=20261016",
    "datum=MLLW", "time_zone=gmt", "units=metric", "interval=hilo", "format=json"]) {
    assert.ok(url.includes(part), part)
  }
})

test("DFO request is a curl argv with a fixed https base, a size cap and a timeout", () => {
  const argv = Tides.PROVIDERS.dfo.request(VANCOUVER.id, Date.UTC(2026, 9, 4), Date.UTC(2026, 9, 16))
  assert.equal(argv[0], "curl")
  assert.ok(argv.includes("--max-filesize"))
  assert.ok(argv.includes("--max-time"))
  const url = argv[argv.length - 1]
  assert.equal(url, "https://api-iwls.dfo-mpo.gc.ca/api/v1/stations/" + VANCOUVER.id +
    "/data?time-series-code=wlp-hilo&from=2026-10-04T00:00:00Z&to=2026-10-16T00:00:00Z")
})

test("a station id that could change the request is refused", () => {
  const from = Date.UTC(2026, 9, 4)
  const to = Date.UTC(2026, 9, 5)
  for (const bad of ["", "94 14", "9414290&units=english", "../x", "9414290;ls", null, undefined, 9414290, "a".repeat(40)]) {
    assert.equal(Tides.PROVIDERS.noaa.request(bad, from, to), null, String(bad))
  }
  for (const bad of ["", "07735", "5cebf1de3d0f4a073c4bb94/../x", VANCOUVER.id + "?x=1", null, 5]) {
    assert.equal(Tides.PROVIDERS.dfo.request(bad, from, to), null, String(bad))
  }
})

test("a request for a bad time range is refused", () => {
  for (const [a, b] of [[NaN, 1], [10, 5], ["x", 5], [0, Infinity]]) {
    assert.equal(Tides.PROVIDERS.noaa.request("9414290", a, b), null)
    assert.equal(Tides.PROVIDERS.dfo.request(VANCOUVER.id, a, b), null)
  }
})

test("adapters name their datum and attribution", () => {
  assert.equal(Tides.PROVIDERS.noaa.datum, "MLLW")
  assert.match(Tides.PROVIDERS.noaa.attribution, /NOAA/)
  assert.match(Tides.PROVIDERS.dfo.datum, /Chart Datum/)
  assert.match(Tides.PROVIDERS.dfo.attribution, /Fisheries and Oceans Canada/)
})

// ---- parsing ------------------------------------------------------------

test("NOAA predictions parse to UTC events with high/low types", () => {
  const events = Tides.PROVIDERS.noaa.parse(fixture("noaa-9414290-gmt.json"))
  assert.equal(events.length, 12)
  assert.deepEqual(events[0], { time: Date.UTC(2026, 9, 5, 1, 32), type: "high", height: 1.721 })
  assert.deepEqual(events[1], { time: Date.UTC(2026, 9, 5, 8, 42), type: "low", height: -0.027 })
  for (let i = 1; i < events.length; i++) assert.ok(events[i].time > events[i - 1].time)
})

test("DFO events get high/low from their neighbours", () => {
  const events = Tides.PROVIDERS.dfo.parse(fixture("dfo-07735-wlp-hilo.json"))
  assert.equal(events.length, 8)
  assert.deepEqual(events.map(e => e.type), ["low", "high", "low", "high", "low", "high", "low", "high"])
  assert.deepEqual(events[0], { time: Date.UTC(2026, 9, 5, 3, 25), type: "low", height: 3.341 })
  assert.deepEqual(events[3], { time: Date.UTC(2026, 9, 5, 22, 20), type: "high", height: 4.462 })
})

test("NOAA answers a bad station with an error body; that is no tides, not zero tides", () => {
  assert.equal(Tides.PROVIDERS.noaa.parse(fixture("noaa-error.json")), null)
})

test("malformed NOAA bodies parse to null or skip the bad entries", () => {
  const noaa = Tides.PROVIDERS.noaa
  for (const raw of ["", "not json", "null", "[]", "42", "{}", '{"predictions":"x"}', '{"predictions":{"a":1}}']) {
    assert.equal(noaa.parse(raw), null, raw)
  }
  assert.deepEqual(noaa.parse('{"predictions":[]}'), [])
  const mixed = JSON.stringify({ predictions: [
    { t: "2026-10-05 01:32", v: "1.7", type: "H" },
    { t: "2026-10-05 02:00", v: "abc", type: "L" },
    { t: "yesterday", v: "1.0", type: "H" },
    { t: "2026-10-05 03:00", v: "1.0", type: "X" },
    { t: "2026-10-05 04:00", v: "", type: "L" },
    { t: "2026-13-45 04:00", v: "1.0", type: "L" },
    { t: "2026-10-05 05:00", v: "1e999", type: "L" },
    null, 7, "x", [],
    { t: "2026-10-05 06:00", v: 0.5, type: "L" },
    { t: "2026-10-05 07:00", v: "-0.4", type: "L" }
  ] })
  assert.deepEqual(noaa.parse(mixed).map(e => [e.type, e.height]), [["high", 1.7], ["low", 0.5], ["low", -0.4]])
})

test("malformed DFO bodies parse to null or skip the bad entries", () => {
  const dfo = Tides.PROVIDERS.dfo
  for (const raw of ["", "not json", "null", "{}", '{"errors":[1]}', "42", '"x"']) {
    assert.equal(dfo.parse(raw), null, raw)
  }
  assert.deepEqual(dfo.parse("[]"), [])
  const mixed = JSON.stringify([
    { eventDate: "2026-10-05T03:00:00Z", value: 1 },
    { eventDate: "2026-10-05T09:00:00Z", value: "2" },
    { eventDate: "2026-10-05T10:00:00Z", value: null },
    { eventDate: "nope", value: 3 },
    { value: 3 },
    null, 5,
    { eventDate: "2026-10-05T15:00:00Z", value: 0.5 },
    { eventDate: "2026-10-05T21:00:00Z", value: 2.5 }
  ])
  assert.deepEqual(dfo.parse(mixed).map(e => [e.type, e.height]), [["high", 1], ["low", 0.5], ["high", 2.5]])
})

test("a lone DFO event cannot be told apart, so it is dropped", () => {
  assert.deepEqual(Tides.PROVIDERS.dfo.parse('[{"eventDate":"2026-10-05T03:00:00Z","value":1}]'), [])
})

// ---- bounds: a response cannot make the panel draw or cache an unbounded list

const flood = n => JSON.stringify({ predictions: Array.from({ length: n }, () => ({ t: "2026-10-05 01:32", v: "1.7", type: "H" })) })

test("4,500 identical NOAA events are one event", () => {
  const raw = flood(4500)
  assert.ok(raw.length > 190000)
  assert.deepEqual(Tides.PROVIDERS.noaa.parse(raw), [{ time: Date.UTC(2026, 9, 5, 1, 32), type: "high", height: 1.7 }])
})

test("a flood of distinct NOAA times is cut to a few per day and a few days", () => {
  const predictions = []
  for (let i = 0; i < 4500; i++) {
    const t = new Date(Date.UTC(2026, 9, 5) + i * 60000)
    predictions.push({
      t: t.toISOString().slice(0, 10) + " " + t.toISOString().slice(11, 16), v: String(i % 7), type: i % 2 ? "H" : "L"
    })
  }
  const events = Tides.PROVIDERS.noaa.parse(JSON.stringify({ predictions }))
  assert.ok(events.length <= Tides.MAX_EVENTS, String(events.length))
  const perDay = {}
  for (const e of events) perDay[Math.floor(e.time / 86400000)] = (perDay[Math.floor(e.time / 86400000)] || 0) + 1
  for (const n of Object.values(perDay)) assert.ok(n <= Tides.MAX_PER_DAY, String(n))
  for (let i = 1; i < events.length; i++) assert.ok(events[i].time >= events[i - 1].time)
})

test("a flood of DFO points is bounded the same way", () => {
  const same = JSON.stringify(Array.from({ length: 4000 }, (_, i) => ({ eventDate: "2026-10-05T03:25:00Z", value: i % 5 })))
  assert.ok(Tides.PROVIDERS.dfo.parse(same).length <= 1)
  const spread = JSON.stringify(Array.from({ length: 4000 }, (_, i) => ({
    eventDate: new Date(Date.UTC(2026, 9, 5) + i * 60000).toISOString().slice(0, 19) + "Z", value: i % 9 })))
  const events = Tides.PROVIDERS.dfo.parse(spread)
  assert.ok(events.length <= Tides.MAX_EVENTS, String(events.length))
})

test("real data is untouched by the bounds", () => {
  assert.equal(Tides.PROVIDERS.noaa.parse(fixture("noaa-9414290-gmt.json")).length, 12)
  assert.equal(Tides.PROVIDERS.dfo.parse(fixture("dfo-07735-wlp-hilo.json")).length, 8)
})

test("a flooded cache file is bounded when it is read, and when it is written", () => {
  const events = Array.from({ length: 5000 }, () => ({ time: 5, type: "high", height: 1 }))
  const text = JSON.stringify({ version: 1, stations: { "noaa:1": { fetchedAt: NOW, events } } })
  assert.equal(Tides.eventsFor(Tides.parseCache(text), "noaa:1").length, 1)
  const many = Array.from({ length: 5000 }, (_, i) => ({ time: i * 60000, type: "low", height: 1 }))
  assert.ok(Tides.eventsFor(Tides.withEntry(Tides.parseCache(""), "noaa:1", many, NOW), "noaa:1").length <= Tides.MAX_EVENTS)
})

test("a day never draws more than a handful of rows", () => {
  const events = Array.from({ length: 300 }, (_, i) => ({ time: Date.UTC(2026, 9, 5, 8) + i * 60000, type: i % 2 ? "high" : "low", height: i }))
  const rows = Tides.dayTides({ station: SF, distanceKm: 1, events }, "2026-10-05", 0, false, false).rows
  assert.ok(rows.length <= Tides.MAX_PER_DAY, String(rows.length))
})

// ---- time zone alignment ------------------------------------------------

test("UTC events line up with NOAA's own local-time listing for the station", () => {
  const events = Tides.PROVIDERS.noaa.parse(fixture("noaa-9414290-gmt.json"))
  const local = JSON.parse(fixture("noaa-9414290-lst_ldt.json")).predictions
  for (const date of ["2026-10-05", "2026-10-06", "2026-10-07"]) {
    const mine = Tides.dayEvents(events, date, PDT).map(e => Tides.clock(e.time, PDT) + " " + e.type[0] + " " + e.height)
    const theirs = local.filter(p => p.t.startsWith(date))
      .map(p => p.t.slice(11) + " " + (p.type === "H" ? "h" : "l") + " " + Number(p.v))
    // The window ends at the 7th's last UTC event, so the 7th may be short.
    if (date === "2026-10-07") assert.deepEqual(mine, theirs.slice(0, mine.length))
    else assert.deepEqual(mine, theirs, date)
  }
})

test("a UTC event just after midnight belongs to the previous local day west of Greenwich", () => {
  const events = Tides.PROVIDERS.noaa.parse(fixture("noaa-9414290-gmt.json"))
  // 2026-10-05 01:32 UTC is 18:32 on the 4th in San Francisco.
  assert.equal(Tides.dayEvents(events, "2026-10-04", PDT).length, 1)
  assert.equal(Tides.dayEvents(events, "2026-10-04", PDT)[0].time, Date.UTC(2026, 9, 5, 1, 32))
})

// New York across the end of daylight-saving time (Nov 1 2026, 06:00 UTC), on a
// forecast fetched Oct 26 whose single offset is EDT (-4h).
const Zone = loadLibrary("Zone.js")
const NY_REPORT = {
  latitude: 40.7, longitude: -74, timezone: "America/New_York", utc_offset_seconds: -14400,
  daily: { time: ["2026-10-26", "2026-10-27", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"] }
}
const nyZone = () => Zone.forReport(NY_REPORT, Zone.parseTable(readFileSync(join(__dirname, "..", "tz-transitions.json"), "utf8")),
  Date.UTC(2026, 9, 26))
const zonedNy = () => Zone.attach(NY_REPORT, nyZone())

test("across the clock change, 04:30 UTC on Nov 2 is Nov 1 at 23:30 in New York", () => {
  const events = [{ time: Date.UTC(2026, 10, 2, 4, 30), type: "high", height: 1 }]
  const day1 = Tides.dayEvents(events, "2026-11-01", nyZone())
  assert.equal(day1.length, 1)
  assert.equal(Tides.clock(day1[0].time, nyZone()), "23:30")
  assert.equal(Tides.dayEvents(events, "2026-11-02", nyZone()).length, 0)
  // The single fetch-time offset gets both wrong, which is the bug this guards.
  assert.equal(Tides.dayEvents(events, "2026-11-02", -14400).length, 1)
})

test("the 25-hour day holds events from 00:00 EDT to 23:59 EST and no more", () => {
  const events = [
    { time: Date.UTC(2026, 10, 1, 3, 59), type: "low", height: 1 },
    { time: Date.UTC(2026, 10, 1, 4, 0), type: "high", height: 1 },
    { time: Date.UTC(2026, 10, 1, 6, 30), type: "low", height: 1 },
    { time: Date.UTC(2026, 10, 2, 4, 59), type: "high", height: 1 },
    { time: Date.UTC(2026, 10, 2, 5, 0), type: "low", height: 1 }
  ]
  assert.deepEqual(Tides.dayEvents(events, "2026-11-01", nyZone()).map(e => e.time),
    [events[1].time, events[2].time, events[3].time])
  assert.deepEqual(Tides.dayEvents(events, "2026-11-02", nyZone()).map(e => e.time), [events[4].time])
})

test("the day card for New York shows the late event on Nov 1 at 23:30, not Nov 2 at 00:30", () => {
  const events = [{ time: Date.UTC(2026, 10, 2, 4, 30), type: "high", height: 1.2 }]
  const info = { station: SF, distanceKm: 3, events }
  const nov1 = Detail.dayDetail(zonedNy(), 2, false, false, undefined, info)
  assert.deepEqual(nov1.tides.rows.map(r => r.value), ["23:30 · 1.2 m"])
  const nov2 = Detail.dayDetail(zonedNy(), 3, false, false, undefined, info)
  assert.deepEqual(nov2.tides.rows.map(r => r.value), ["—"])
})

test("the request window follows each end's own offset", () => {
  const win = Tides.windowFor(zonedNy())
  assert.equal(win.fromMs, Date.UTC(2026, 9, 26, 4) - 24 * HOUR)
  assert.equal(win.toMs, Date.UTC(2026, 10, 4, 5) + 48 * HOUR)
})

test("east of Greenwich the same UTC event lands on the next local day", () => {
  const events = [{ time: Date.UTC(2026, 9, 4, 22, 30), type: "high", height: 1 }]
  assert.equal(Tides.dayEvents(events, "2026-10-05", 11 * 3600).length, 1)
  assert.equal(Tides.dayEvents(events, "2026-10-04", 11 * 3600).length, 0)
})

test("DFO Vancouver events fall on the right local day", () => {
  const events = Tides.PROVIDERS.dfo.parse(fixture("dfo-07735-wlp-hilo.json"))
  const day = Tides.dayEvents(events, "2026-10-05", PDT)
  assert.deepEqual(day.map(e => Tides.clock(e.time, PDT) + " " + e.type[0] + " " + e.height),
    ["07:39 l 1.158", "15:20 h 4.462", "21:26 l 3.011"])
})

test("day rows are timed in the forecast zone, 12 or 24 hour, with the unit asked for", () => {
  const events = Tides.PROVIDERS.dfo.parse(fixture("dfo-07735-wlp-hilo.json"))
  const info = { station: VANCOUVER, distanceKm: 3.2, events }
  const rows = Tides.dayTides(info, "2026-10-05", PDT, false, false).rows
  assert.deepEqual(rows.map(r => [r.label, r.value]),
    [["Low", "07:39 · 1.2 m"], ["High", "15:20 · 4.5 m"], ["Low", "21:26 · 3.0 m"]])
  const imperial = Tides.dayTides(info, "2026-10-05", PDT, true, true).rows
  assert.deepEqual(imperial.map(r => r.value), ["7:39 AM · 3.8 ft", "3:20 PM · 14.6 ft", "9:26 PM · 9.9 ft"])
})

test("each tide row has its time and height as separate cells", () => {
  const events = Tides.PROVIDERS.dfo.parse(fixture("dfo-07735-wlp-hilo.json"))
  const info = { station: VANCOUVER, distanceKm: 3.2, events }
  const metric = Tides.dayTides(info, "2026-10-05", PDT, false, false).rows
  assert.deepEqual(metric.map(r => [r.label, r.time, r.height]),
    [["Low", "07:39", "1.2 m"], ["High", "15:20", "4.5 m"], ["Low", "21:26", "3.0 m"]])
  const long = Tides.dayTides({ station: SF, distanceKm: 1, events: [{ time: Date.UTC(2026, 9, 5, 19, 30), type: "high", height: 3.8 }] },
    "2026-10-05", 0, true, true).rows[0]
  assert.deepEqual([long.time, long.height], ["7:30 PM", "12.5 ft"])
  const dash = Tides.dayTides({ station: SF, distanceKm: 1, events: [] }, "2026-10-05", PDT, false, false).rows[0]
  assert.equal(dash.time, undefined)
})

test("a day with no events, or no events loaded, shows a dash", () => {
  const info = { station: SF, distanceKm: 1, events: [] }
  assert.deepEqual(Tides.dayTides(info, "2026-10-05", PDT, false, false).rows, [{ key: "tides", label: "Tides", value: "—" }])
  const loading = Tides.dayTides({ station: SF, distanceKm: 1, events: null }, "2026-10-05", PDT, false, false)
  assert.deepEqual(loading.rows, [{ key: "tides", label: "Tides", value: "—" }])
  assert.match(loading.station, /San Francisco/)
})

test("the card names the station, its distance, the datum and the source", () => {
  const info = { station: SF, distanceKm: 12.4, events: [] }
  const metric = Tides.dayTides(info, "2026-10-05", PDT, false, false)
  assert.equal(metric.station, "San Francisco · 12 km")
  assert.equal(Tides.dayTides(info, "2026-10-05", PDT, true, false).station, "San Francisco · 7.7 mi")
  assert.equal(Tides.dayTides({ station: SF, distanceKm: 40, events: [] }, "2026-10-05", PDT, true, false).station, "San Francisco · 25 mi")
  assert.match(metric.datum, /MLLW/)
  assert.match(metric.credit, /NOAA/)
  const dfo = Tides.dayTides({ station: VANCOUVER, distanceKm: 0.5, events: [] }, "2026-10-05", PDT, false, false)
  assert.match(dfo.datum, /Chart Datum/)
  assert.match(dfo.credit, /Fisheries and Oceans Canada/)
  assert.equal(dfo.station, "Vancouver · 0.5 km")
})

test("no station or no usable offset means no tide card", () => {
  assert.equal(Tides.dayTides(null, "2026-10-05", PDT, false, false), null)
  assert.equal(Tides.dayTides({ station: null, events: [] }, "2026-10-05", PDT, false, false), null)
  assert.equal(Tides.dayTides({ station: SF, distanceKm: 1, events: [] }, "2026-10-05", NaN, false, false), null)
  assert.equal(Tides.dayTides({ station: SF, distanceKm: 1, events: [] }, "bad", PDT, false, false), null)
})

// ---- heights ------------------------------------------------------------

test("heights are metres or feet, one decimal, never a negative zero", () => {
  assert.equal(Tides.formatHeight(1.721, false), "1.7 m")
  assert.equal(Tides.formatHeight(1.721, true), "5.6 ft")
  assert.equal(Tides.formatHeight(0, false), "0.0 m")
  assert.equal(Tides.formatHeight(-0.027, false), "0.0 m")
  assert.equal(Tides.formatHeight(-0.027, true), "-0.1 ft")
  assert.equal(Tides.formatHeight(-0.5, true), "-1.6 ft")
  assert.equal(Tides.formatHeight(12.04, false), "12.0 m")
})

test("a missing or malformed height is a dash", () => {
  for (const bad of [null, undefined, NaN, Infinity, "1.2", [], {}, true]) {
    assert.equal(Tides.formatHeight(bad, false), "—", String(bad))
  }
})

// ---- the shipped station index ------------------------------------------

test("the station index is valid, small, and covers both providers", () => {
  assert.ok(statSync(INDEX_PATH).size < 150 * 1024, "index over 150 KB")
  const stations = realIndex()
  assert.ok(stations.length > 1000)
  assert.ok(stations.some(s => s.provider === "noaa"))
  assert.ok(stations.some(s => s.provider === "dfo"))
  const keys = new Set()
  for (const s of stations) {
    assert.ok(s.name.length > 0 && Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180, JSON.stringify(s))
    assert.ok(Tides.PROVIDERS[s.provider].request(s.id, 0, 1) !== null, "unsafe id " + s.id)
    assert.ok(!keys.has(s.provider + ":" + s.id), "duplicate " + s.id)
    keys.add(s.provider + ":" + s.id)
  }
})

test("parseIndex keeps valid rows and drops bad ones", () => {
  const text = JSON.stringify({ version: 1, noaa: [["9414290", "SF", 37.8, -122.4], ["bad id", "x", 1, 1], ["1", "y", 91, 0],
    ["2", "z", "1", 1], [3, "w", 1, 1], null, "x", ["4", "ok", 0, 0]], dfo: "no", extra: [] })
  assert.deepEqual(Tides.parseIndex(text).map(s => s.provider + ":" + s.id), ["noaa:9414290", "noaa:4"])
  for (const bad of ["", "nope", "null", "[]", "42", "{}"]) assert.deepEqual(Tides.parseIndex(bad), [])
})

// ---- nearest station ----------------------------------------------------

test("great-circle distance is right on known pairs", () => {
  assert.ok(Math.abs(Tides.distanceKm(0, 0, 0, 1) - 111.19) < 0.1)
  assert.ok(Math.abs(Tides.distanceKm(51.5, -0.12, 48.85, 2.35) - 343.6) < 2)
  assert.ok(Math.abs(Tides.distanceKm(0, 179.9, 0, -179.9) - 22.2) < 0.1)
  assert.equal(Tides.distanceKm(10, 10, 10, 10), 0)
})

test("the nearest real station is found for places on both providers' coasts", () => {
  const stations = realIndex()
  const sf = Tides.nearestStation(stations, 37.7749, -122.4194, 40)
  assert.equal(sf.station.provider, "noaa")
  assert.ok(sf.km < 15)
  const vancouver = Tides.nearestStation(stations, 49.2827, -123.1207, 40)
  assert.equal(vancouver.station.provider, "dfo")
  assert.ok(vancouver.km < 10, "km " + vancouver.km)
  assert.equal(Tides.nearestStation(stations, 21.3069, -157.8583, 40).station.provider, "noaa")
  assert.equal(Tides.nearestStation(stations, 48.4284, -123.3656, 40).station.provider, "dfo")
})

test("places with no station in range have none, including far from any coast", () => {
  const stations = realIndex()
  for (const [name, lat, lon] of [["Sydney", -33.8688, 151.2093], ["Longyearbyen", 78.2232, 15.6267],
    ["Denver", 39.7392, -104.9903], ["mid-Pacific", 0, -140], ["South Pole", -90, 0], ["north pole", 90, 0]]) {
    assert.equal(Tides.nearestStation(stations, lat, lon, Tides.AUTO_MAX_KM), null, name)
  }
})

test("the nearest of several wins, across the antimeridian too", () => {
  const stations = [
    { provider: "noaa", id: "1", name: "far", lat: 0, lon: 170 },
    { provider: "noaa", id: "2", name: "near", lat: 0, lon: 179.9 },
    { provider: "dfo", id: "3".repeat(24), name: "mid", lat: 0, lon: 175 }
  ]
  assert.equal(Tides.nearestStation(stations, 0, -179.95, 40).station.id, "2")
})

test("bad coordinates or range give no station", () => {
  const stations = [SF]
  for (const [lat, lon, km] of [[NaN, 0, 40], [91, 0, 40], [0, 181, 40], ["37", -122, 40], [null, 0, 40], [37.8, -122.4, NaN],
    [37.8, -122.4, -1], [37.8, -122.4, "40"]]) {
    assert.equal(Tides.nearestStation(stations, lat, lon, km), null, JSON.stringify([lat, lon, km]))
  }
  assert.equal(Tides.nearestStation(null, 37.8, -122.4, 40), null)
  assert.equal(Tides.nearestStation([], 37.8, -122.4, 40), null)
})

// ---- the one `tides` setting: auto, on, off ----------------------------------

// A place whose nearest station (SF, 37.806 -122.465) is the given distance due north.
const northOfSf = km => ({ lat: 37.806 + km / 111.195, lon: -122.465 })

test("the auto threshold is a named constant of 100 km, not a setting", () => {
  assert.equal(Tides.AUTO_MAX_KM, 100)
})

test("the setting has three values and anything else means auto", () => {
  for (const v of ["auto", "on", "off"]) assert.equal(Tides.normalizeMode(v), v)
  for (const bad of [undefined, null, "", "ON", "true", true, false, 1, {}, [], "auto "]) assert.equal(Tides.normalizeMode(bad), "auto", String(bad))
})

test("auto: a station just inside 100 km shows, just outside shows nothing", () => {
  const stations = [SF]
  const inside = northOfSf(99.5)
  const outside = northOfSf(100.5)
  assert.ok(Math.abs(Tides.distanceKm(inside.lat, inside.lon, SF.lat, SF.lon) - 99.5) < 0.05)
  assert.ok(Math.abs(Tides.distanceKm(outside.lat, outside.lon, SF.lat, SF.lon) - 100.5) < 0.05)
  const found = Tides.stationFor(stations, inside.lat, inside.lon, "auto")
  assert.equal(found.station.id, "9414290")
  assert.ok(found.km < 100)
  assert.equal(Tides.stationFor(stations, outside.lat, outside.lon, "auto"), null)
})

test("auto: exactly 100 km is still in range, and the default is auto", () => {
  const exactly = northOfSf(100)
  const km = Tides.distanceKm(exactly.lat, exactly.lon, SF.lat, SF.lon)
  assert.equal(Tides.stationFor([SF], exactly.lat, exactly.lon, "auto") !== null, km <= 100)
  assert.ok(Tides.stationFor([SF], 37.8, -122.4, undefined) !== null)
  assert.equal(Tides.stationFor([SF], -33.9, 151.2, undefined), null)
})

test("on: the nearest station at any distance", () => {
  const stations = realIndex()
  const sydney = Tides.stationFor(stations, -33.8688, 151.2093, "on")
  assert.ok(sydney !== null && sydney.km > 1000)
  const outside = northOfSf(250)
  assert.equal(Tides.stationFor([SF], outside.lat, outside.lon, "auto"), null)
  assert.equal(Tides.stationFor([SF], outside.lat, outside.lon, "on").station.id, "9414290")
  const antipode = Tides.stationFor([SF], -37.8, 57.5, "on")
  assert.ok(antipode.km > 19000)
})

test("on with no station in the index at all is still nothing", () => {
  assert.equal(Tides.stationFor([], 37.8, -122.4, "on"), null)
  assert.equal(Tides.stationFor(null, 37.8, -122.4, "on"), null)
})

test("off: never a station, however close", () => {
  assert.equal(Tides.stationFor([SF], SF.lat, SF.lon, "off"), null)
  assert.equal(Tides.stationFor(realIndex(), 37.7749, -122.4194, "off"), null)
})

test("bad coordinates give no station in any mode", () => {
  for (const mode of ["auto", "on", "off"]) {
    for (const [lat, lon] of [[NaN, 0], [91, 0], [0, 181], ["37", -122], [null, 0], [undefined, undefined]]) {
      assert.equal(Tides.stationFor([SF], lat, lon, mode), null, mode + JSON.stringify([lat, lon]))
    }
  }
})

test("the cache never lets a nearby place borrow another's answer across the 100 km line", () => {
  const inside = { lat: SF.lat + 0.899, lon: SF.lon }
  const outside = { lat: SF.lat + 0.8994, lon: SF.lon }
  const km = p => Tides.distanceKm(p.lat, p.lon, SF.lat, SF.lon)
  assert.ok(km(inside) < 100 && km(outside) > 100, `${km(inside)} ${km(outside)}`)
  // Both call orders, in fresh index arrays so no earlier entry is reused.
  const a = [SF]
  assert.ok(Tides.stationFor(a, inside.lat, inside.lon, "auto") !== null)
  assert.equal(Tides.stationFor(a, outside.lat, outside.lon, "auto"), null)
  const b = [SF, { provider: "noaa", id: "ZZZ", name: "far away", lat: -80, lon: 0 }]
  assert.equal(Tides.stationFor(b, outside.lat, outside.lon, "auto"), null)
  assert.ok(Tides.stationFor(b, inside.lat, inside.lon, "auto") !== null)
  // The distance reported is that place's own.
  assert.ok(Math.abs(Tides.stationFor(a, inside.lat, inside.lon, "auto").km - km(inside)) < 1e-9)
  assert.ok(Math.abs(Tides.stationFor(a, outside.lat, outside.lon, "on").km - km(outside)) < 1e-9)
})

test("the choice is cached per place and mode, including no station", () => {
  const stations = [SF]
  const before = Tides.choiceCacheSize()
  const first = Tides.stationFor(stations, 37.71, -122.31, "auto")
  assert.equal(first, Tides.stationFor(stations, 37.71, -122.31, "auto"))
  assert.equal(Tides.choiceCacheSize(), before + 1)
  assert.equal(Tides.stationFor(stations, -33.91, 151.21, "auto"), null)
  assert.equal(Tides.stationFor(stations, -33.91, 151.21, "auto"), null)
  assert.equal(Tides.choiceCacheSize(), before + 2)
  // The same place under another mode is another question.
  Tides.stationFor(stations, -33.91, 151.21, "on")
  assert.equal(Tides.choiceCacheSize(), before + 3)
})

test("the choice cache stays bounded", () => {
  for (let i = 0; i < 400; i++) Tides.stationFor([SF], 10 + i / 100, 20, "auto")
  assert.ok(Tides.choiceCacheSize() <= 128)
})

// ---- the once-a-day cache -----------------------------------------------

const NOW = Date.UTC(2026, 9, 5, 12)
const HOUR = 3600 * 1000

test("with no entry a fetch is needed; within a day it is not; after a day it is", () => {
  const key = "noaa:9414290"
  let cache = Tides.parseCache("")
  assert.equal(Tides.needsFetch(cache, key, NOW), true)
  cache = Tides.withEntry(cache, key, [{ time: 1, type: "high", height: 1 }], NOW)
  assert.equal(Tides.needsFetch(cache, key, NOW + 23 * HOUR), false)
  assert.equal(Tides.needsFetch(cache, key, NOW + 24 * HOUR), true)
  assert.equal(Tides.needsFetch(cache, "noaa:other", NOW), true)
  assert.equal(Tides.needsFetch(cache, key, NOW - HOUR), false)
})

test("an entry from the future is not trusted", () => {
  const cache = Tides.withEntry(Tides.parseCache(""), "noaa:1", [], NOW)
  assert.equal(Tides.needsFetch(cache, "noaa:1", NOW - 3 * 24 * HOUR), true)
})

test("cache entries are kept per station", () => {
  let cache = Tides.withEntry(Tides.parseCache(""), "noaa:1", [{ time: 1, type: "high", height: 1 }], NOW)
  cache = Tides.withEntry(cache, "dfo:2", [{ time: 2, type: "low", height: 2 }], NOW)
  assert.deepEqual(Tides.eventsFor(cache, "noaa:1"), [{ time: 1, type: "high", height: 1 }])
  assert.deepEqual(Tides.eventsFor(cache, "dfo:2"), [{ time: 2, type: "low", height: 2 }])
  assert.equal(Tides.eventsFor(cache, "noaa:3"), null)
  assert.equal(Tides.eventsFor(null, "noaa:1"), null)
})

test("the cache survives a round trip and drops anything malformed", () => {
  let cache = Tides.withEntry(Tides.parseCache(""), "noaa:1", [{ time: 5, type: "high", height: 1.5 }], NOW)
  const back = Tides.parseCache(Tides.serializeCache(cache))
  assert.deepEqual(Tides.eventsFor(back, "noaa:1"), [{ time: 5, type: "high", height: 1.5 }])
  assert.equal(Tides.needsFetch(back, "noaa:1", NOW + HOUR), false)

  for (const bad of ["", "nope", "null", "[]", "42", "{}", '{"stations":[]}', '{"version":1,"stations":"x"}']) {
    assert.equal(Tides.eventsFor(Tides.parseCache(bad), "noaa:1"), null, bad)
  }
  const dirty = JSON.stringify({ version: 1, stations: {
    "noaa:1": { fetchedAt: NOW, events: [{ time: 5, type: "high", height: 1.5 }, { time: "x", type: "high", height: 1 },
      { time: 6, type: "sideways", height: 1 }, { time: 7, type: "low", height: null }, null] },
    "noaa:2": { fetchedAt: "yesterday", events: [] },
    "noaa:3": { fetchedAt: NOW, events: "none" },
    "bad key": { fetchedAt: NOW, events: [] },
    "noaa:4": null
  } })
  const parsed = Tides.parseCache(dirty)
  assert.deepEqual(Tides.eventsFor(parsed, "noaa:1"), [{ time: 5, type: "high", height: 1.5 }])
  for (const key of ["noaa:2", "noaa:3", "bad key", "noaa:4"]) assert.equal(Tides.eventsFor(parsed, key), null, key)
})

test("the cache keeps only the most recently fetched stations", () => {
  let cache = Tides.parseCache("")
  for (let i = 0; i < 30; i++) cache = Tides.withEntry(cache, "noaa:" + i, [], NOW + i * 1000)
  assert.equal(Tides.eventsFor(cache, "noaa:29") !== null, true)
  assert.equal(Tides.eventsFor(cache, "noaa:0"), null)
  assert.ok(Object.keys(cache.stations).length <= 12)
})

test("withEntry does not change the cache it was given", () => {
  const original = Tides.parseCache("")
  Tides.withEntry(original, "noaa:1", [], NOW)
  assert.equal(Tides.eventsFor(original, "noaa:1"), null)
})

// ---- a response answers only the question that was asked ----------------

test("a response is used only if its station is still the one wanted", () => {
  const asked = { key: "noaa:9414290" }
  assert.equal(Tides.isCurrent(asked, "noaa:9414290"), true)
  assert.equal(Tides.isCurrent(asked, "noaa:9414291"), false)
  assert.equal(Tides.isCurrent(asked, "dfo:9414290"), false)
  assert.equal(Tides.isCurrent(asked, ""), false)
  assert.equal(Tides.isCurrent(asked, null), false)
  assert.equal(Tides.isCurrent(null, "noaa:9414290"), false)
  assert.equal(Tides.isCurrent({}, "noaa:9414290"), false)
  assert.equal(Tides.isCurrent({ key: "" }, ""), false)
})

// ---- window and file path -----------------------------------------------

test("the request window covers every forecast day plus a day either side, in UTC", () => {
  const report = { utc_offset_seconds: PDT, daily: { time: ["2026-10-05", "2026-10-06", "2026-10-14"] } }
  const win = Tides.windowFor(report)
  // Local midnight 2026-10-05 in PDT is 07:00 UTC.
  assert.equal(win.fromMs, Date.UTC(2026, 9, 5, 7) - 24 * HOUR)
  assert.equal(win.toMs, Date.UTC(2026, 9, 14, 7) + 48 * HOUR)
})

test("no usable forecast days or offset means no window", () => {
  for (const bad of [null, {}, { daily: { time: [] }, utc_offset_seconds: 0 }, { daily: { time: ["2026-10-05"] } },
    { daily: { time: ["nope"] }, utc_offset_seconds: 0 }, { daily: { time: "x" }, utc_offset_seconds: 0 },
    { daily: { time: ["2026-10-05"] }, utc_offset_seconds: "0" }]) {
    assert.equal(Tides.windowFor(bad), null, JSON.stringify(bad))
  }
})


// ---- the card -------------------------------------------------------------

test("the day card carries tide rows when it is given a station", () => {
  const report = {
    utc_offset_seconds: PDT,
    daily: { time: ["2026-10-05"], temperature_2m_max: [20], temperature_2m_min: [10] }
  }
  const events = Tides.PROVIDERS.dfo.parse(fixture("dfo-07735-wlp-hilo.json"))
  const card = Detail.dayDetail(report, 0, false, false, undefined, { station: VANCOUVER, distanceKm: 3.2, events })
  assert.equal(card.tides.rows.length, 3)
  assert.equal(card.tides.station, "Vancouver · 3.2 km")
  assert.equal(Detail.dayDetail(report, 0, false, false).tides, null)
  assert.equal(Detail.dayDetail(report, 0, false, false, undefined, null).tides, null)
})

// ---- the tide wave behind the hourly strip -------------------------------------

const HOUR_MS = 3600 * 1000
const ev = (h, type, height) => ({ time: Date.UTC(2026, 9, 5, h), type, height })
// High 2.0 at 06:00, low 0.0 at 12:00, high 2.0 at 18:00 (UTC).
const SWING = [ev(6, "high", 2), ev(12, "low", 0), ev(18, "high", 2)]

test("half-cosine interpolation is exact at the events", () => {
  for (const e of SWING) assert.equal(Tides.waveHeight(SWING, e.time), e.height)
})

test("between events the height follows h0 + (h1 - h0) * (1 - cos(pi t)) / 2", () => {
  const t0 = SWING[0].time
  const t1 = SWING[1].time
  for (const f of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const expected = 2 + (0 - 2) * (1 - Math.cos(Math.PI * f)) / 2
    assert.ok(Math.abs(Tides.waveHeight(SWING, t0 + f * (t1 - t0)) - expected) < 1e-12, String(f))
  }
  assert.equal(Tides.waveHeight(SWING, Date.UTC(2026, 9, 5, 9)), 1)
})

test("it falls monotonically from a high to a low and rises monotonically back", () => {
  let last = Infinity
  for (let m = 0; m <= 360; m += 5) {
    const h = Tides.waveHeight(SWING, Date.UTC(2026, 9, 5, 6, m))
    assert.ok(h <= last + 1e-12, `fall at ${m}`)
    last = h
  }
  last = -Infinity
  for (let m = 0; m <= 360; m += 5) {
    const h = Tides.waveHeight(SWING, Date.UTC(2026, 9, 5, 12, m))
    assert.ok(h >= last - 1e-12, `rise at ${m}`)
    last = h
  }
  for (let m = 0; m <= 360; m += 5) {
    const h = Tides.waveHeight(SWING, Date.UTC(2026, 9, 5, 6, m))
    assert.ok(h >= 0 && h <= 2)
  }
})

test("nothing is drawn before the first event or after the last", () => {
  assert.equal(Tides.waveHeight(SWING, SWING[0].time - 1), null)
  assert.equal(Tides.waveHeight(SWING, SWING[2].time + 1), null)
  assert.equal(Tides.waveHeight([], SWING[0].time), null)
  assert.equal(Tides.waveHeight(null, SWING[0].time), null)
  assert.equal(Tides.waveHeight(SWING, NaN), null)
  assert.equal(Tides.waveHeight(SWING, "x"), null)
})

test("the longest interval interpolated is a named 26 hours", () => {
  assert.equal(Tides.MAX_WAVE_INTERVAL_MS, 26 * 3600000)
})

test("an interval of exactly 26 hours is drawn, one millisecond more is not", () => {
  const edge = [ev(0, "high", 2), { time: Date.UTC(2026, 9, 5, 26), type: "low", height: 0 }]
  assert.equal(Tides.waveHeight(edge, Date.UTC(2026, 9, 5, 13)), 1)
  const wide = [ev(0, "high", 2), { time: Date.UTC(2026, 9, 5, 26, 0, 0, 1), type: "low", height: 0 }]
  assert.equal(Tides.waveHeight(wide, Date.UTC(2026, 9, 5, 13)), null)
  assert.equal(Tides.waveHeight(wide, wide[0].time), 2)
  assert.equal(Tides.waveHeight(wide, wide[1].time), 0)
})

test("the stretches either side of a gap over 26 hours still draw", () => {
  const split = [ev(0, "high", 2), ev(6, "low", 0), ev(33, "high", 2), ev(39, "low", 0)]
  assert.notEqual(Tides.waveHeight(split, Date.UTC(2026, 9, 5, 3)), null)
  assert.equal(Tides.waveHeight(split, Date.UTC(2026, 9, 5, 20)), null)
  assert.notEqual(Tides.waveHeight(split, Date.UTC(2026, 9, 5, 36)), null)
})

// Weeks Bay, Alabama (NOAA 8765148) is a diurnal station: on 2026-10-05 the high is
// at 10:37 UTC (05:37 local) and the next low at 02:34 UTC on the 6th (21:34 local),
// almost 16 hours later. test/fixtures/noaa-8765148-gmt.json is the real response.
test("a legitimate 16-hour diurnal interval at Weeks Bay is drawn", () => {
  const events = Tides.PROVIDERS.noaa.parse(fixture("noaa-8765148-gmt.json"))
  const high = events.find(e => e.time === Date.UTC(2026, 9, 5, 10, 37))
  const low = events.find(e => e.time === Date.UTC(2026, 9, 6, 2, 34))
  assert.equal(high.type, "high")
  assert.equal(low.type, "low")
  const hours = (low.time - high.time) / HOUR_MS
  assert.ok(hours > 15.9 && hours < 16, String(hours))
  const mid = high.time + (low.time - high.time) / 2
  assert.ok(Math.abs(Tides.waveHeight(events, mid) - (high.height + low.height) / 2) < 1e-9)
  // The strip's visible daytime hours, 06:00-21:00 local (11:00-02:00Z), have a wave.
  const axis = Array.from({ length: 16 }, (_, i) => Date.UTC(2026, 9, 5, 11 + i))
  const wave = Tides.wave(events, axis)
  assert.notEqual(wave, null)
  assert.ok(wave.samples.filter(x => x.h !== null).length >= 60)
  assert.equal(wave.samples.filter(x => x.h === null).length, 0)
  // The high at 10:37Z is inside the span (which starts at 10:30Z); the low at 02:34Z is just past its end.
  assert.deepEqual(wave.marks.map(m => m.type), ["high"])
  const layout = Tides.waveLayout(wave, { cell: 40, gap: 4, count: 16, height: 100 })
  assert.ok(layout.path.every(p => p !== null))
})

test("events of the same type are never interpolated between", () => {
  const twoHighs = [ev(0, "high", 2), ev(10, "high", 1.5)]
  assert.equal(Tides.waveHeight(twoHighs, Date.UTC(2026, 9, 5, 5)), null)
  const twoLows = [ev(0, "low", 0), ev(10, "low", 0.2)]
  assert.equal(Tides.waveHeight(twoLows, Date.UTC(2026, 9, 5, 5)), null)
  // Opposite types either side of the pair still draw.
  const run = [ev(0, "low", 0), ev(6, "high", 2), ev(12, "high", 1.8), ev(18, "low", 0)]
  assert.notEqual(Tides.waveHeight(run, Date.UTC(2026, 9, 5, 3)), null)
  assert.equal(Tides.waveHeight(run, Date.UTC(2026, 9, 5, 9)), null)
  assert.notEqual(Tides.waveHeight(run, Date.UTC(2026, 9, 5, 15)), null)
})

test("an event with an unusable height or type breaks the curve instead of being skipped over", () => {
  for (const bad of [{ type: "low", height: NaN }, { type: "low", height: Infinity }, { type: "low", height: "0" },
    { type: "low", height: null }, { type: "sideways", height: 0 }]) {
    const events = [ev(0, "high", 2), Object.assign({ time: Date.UTC(2026, 9, 5, 6) }, bad), ev(12, "low", 0)]
    assert.equal(Tides.waveHeight(events, Date.UTC(2026, 9, 5, 3)), null, JSON.stringify(bad))
    assert.equal(Tides.waveHeight(events, Date.UTC(2026, 9, 5, 9)), null, JSON.stringify(bad))
    assert.equal(Tides.waveHeight(events, Date.UTC(2026, 9, 5, 0)), 2)
    assert.equal(Tides.waveHeight(events, Date.UTC(2026, 9, 5, 12)), 0)
  }
})

test("timestamps must strictly increase between the endpoints", () => {
  const same = [ev(0, "high", 2), ev(6, "low", 0), { time: Date.UTC(2026, 9, 5, 6), type: "high", height: 2 }, ev(12, "low", 0)]
  // Two events at 06:00 leave nothing to interpolate across between them.
  assert.equal(Tides.waveHeight(same, Date.UTC(2026, 9, 5, 9)) !== null, true)
  assert.equal(Tides.waveHeight([ev(6, "low", 0), ev(6, "high", 2)], Date.UTC(2026, 9, 5, 6, 30)), null)
  for (const t of [NaN, Infinity, "x", null]) {
    const events = [ev(0, "high", 2), { time: t, type: "low", height: 0 }, ev(12, "low", 0)]
    assert.equal(Tides.waveHeight(events, Date.UTC(2026, 9, 5, 6)), 1)
  }
})

test("malformed or unsorted events are ignored or put in order", () => {
  const messy = [ev(18, "high", 2), null, { time: "x", type: "low", height: 0 }, ev(6, "high", 2), ev(12, "low", 0), 5,
    { time: Date.UTC(2026, 9, 5, 13), type: "low", height: NaN }]
  assert.equal(Tides.waveHeight(messy, Date.UTC(2026, 9, 5, 9)), 1)
})

test("the hour axis is the report's own hourly strings read in the offset they were written in", () => {
  const report = {
    utc_offset_seconds: -14400,
    hourly: { time: ["2026-11-01T00:00", "2026-11-01T01:00", "2026-11-01T02:00", "2026-11-01T03:00"] }
  }
  const hours = [{ reportIndex: 1 }, { reportIndex: 2 }, { reportIndex: 3 }]
  assert.deepEqual(Tides.hourEpochs(report, hours), [Date.UTC(2026, 10, 1, 5), Date.UTC(2026, 10, 1, 6), Date.UTC(2026, 10, 1, 7)])
  for (const bad of [[{ reportIndex: 9 }], [{ reportIndex: -1 }], [{}], [null], "x"]) assert.deepEqual(Tides.hourEpochs(report, bad), [])
  assert.deepEqual(Tides.hourEpochs({ hourly: { time: ["2026-11-01T00:00"] } }, [{ reportIndex: 0 }]), [])
  assert.deepEqual(Tides.hourEpochs(null, hours), [])
})

const hoursFrom = (h, n) => Array.from({ length: n }, (_, i) => Date.UTC(2026, 9, 5, h + i))

test("the wave covers exactly the hours shown, half an hour either side of the first and last", () => {
  const wave = Tides.wave(SWING, hoursFrom(5, 10)) // 05:00 .. 14:00
  assert.equal(wave.fromMs, Date.UTC(2026, 9, 5, 4, 30))
  assert.equal(wave.toMs, Date.UTC(2026, 9, 5, 14, 30))
  const first = wave.samples[0]
  const last = wave.samples[wave.samples.length - 1]
  assert.equal(first.fi, -0.5)
  assert.equal(last.fi, 9.5)
  // 04:30-06:00 is before the first event: nothing drawn there.
  assert.equal(first.h, null)
  assert.notEqual(last.h, null)
  assert.ok(wave.samples.every(s => s.fi >= -0.5 && s.fi <= 9.5))
})

test("marks are the highs and lows inside the span, and only those", () => {
  const wave = Tides.wave(SWING, hoursFrom(5, 10))
  assert.deepEqual(wave.marks.map(m => [m.type, m.fi, m.h]), [["high", 1, 2], ["low", 7, 0]])
  const edgeIn = Tides.wave([ev(4, "low", 0), ev(5, "high", 2), ev(14, "low", 0), ev(15, "high", 2)], hoursFrom(5, 10))
  assert.deepEqual(edgeIn.marks.map(m => m.fi), [0, 9])
})

test("with no events in range, or inputs that are not hours, there is no wave", () => {
  assert.equal(Tides.wave(SWING, hoursFrom(20, 3)), null)
  assert.equal(Tides.wave([], hoursFrom(5, 10)), null)
  assert.equal(Tides.wave(null, hoursFrom(5, 10)), null)
  assert.equal(Tides.wave(SWING, []), null)
  assert.equal(Tides.wave(SWING, [NaN]), null)
  assert.equal(Tides.wave(SWING, [Date.UTC(2026, 9, 5, 5), Date.UTC(2026, 9, 5, 8)]), null)
})

test("across the daylight-saving change the wave runs on real elapsed time", () => {
  const zone = nyZone()
  const report = { utc_offset_seconds: -14400, hourly: { time: [] } }
  for (let h = 0; h < 8; h++) report.hourly.time.push(`2026-11-01T0${h}:00`)
  const hours = report.hourly.time.map((_, i) => ({ reportIndex: i }))
  const axis = Tides.hourEpochs(report, hours)
  // Eight consecutive real hours; the wall clock repeats 01:00 on the way.
  assert.deepEqual(axis.map((t, i) => i === 0 ? 1 : (t - axis[i - 1]) / HOUR_MS), [1, 1, 1, 1, 1, 1, 1, 1])
  assert.deepEqual(axis.map(t => Zone.clock(zone, t)), ["00:00", "01:00", "01:00", "02:00", "03:00", "04:00", "05:00", "06:00"])
  // A high at 05:00Z and a low at 11:00Z: the wave is the same over the repeated hour as any other.
  const events = [{ time: Date.UTC(2026, 10, 1, 5), type: "high", height: 2 }, { time: Date.UTC(2026, 10, 1, 11), type: "low", height: 0 }]
  const wave = Tides.wave(events, axis)
  const at = fi => wave.samples.find(s => s.fi === fi).h
  assert.equal(at(1), 2 + (0 - 2) * (1 - Math.cos(Math.PI * 0)) / 2)
  assert.ok(Math.abs(at(2) - (1 + Math.cos(Math.PI / 6))) < 1e-9)
  assert.ok(Math.abs(at(3) - (1 + Math.cos(Math.PI / 3))) < 1e-9)
  assert.deepEqual(wave.marks.map(m => [m.type, m.fi]), [["high", 1], ["low", 7]])
  // Placed by local clock rather than UTC it would drift an hour: 05:00Z is 01:00 EDT, not 00:00 EST.
  assert.equal(Zone.clock(zone, events[0].time), "01:00")
})

test("the layout scales to the visible span's min and max, in the lower part of the strip", () => {
  const wave = Tides.wave(SWING, hoursFrom(5, 10))
  const layout = Tides.waveLayout(wave, { cell: 40, gap: 4, count: 10, height: 100 })
  const ys = layout.path.filter(p => p !== null).map(p => p.y)
  assert.ok(Math.min(...ys) >= Tides.WAVE_BAND_TOP * 100 - 1e-9 && Math.max(...ys) <= Tides.WAVE_BAND_BOTTOM * 100 + 1e-9)
  // The high mark is the visible maximum and sits highest, the low mark lowest.
  const high = layout.marks.find(m => m.type === "high")
  const low = layout.marks.find(m => m.type === "low")
  assert.equal(high.y, Math.min(...ys))
  assert.equal(low.y, Math.max(...ys))
  // Cell centres: hour index 1 is the second cell, 44 px on, centre at 44 + 20.
  assert.equal(high.x, 64)
  assert.equal(low.x, 7 * 44 + 20)
})

test("the layout leaves gaps as nulls and a flat span in the middle of the band", () => {
  const wave = Tides.wave(SWING, hoursFrom(5, 10))
  const layout = Tides.waveLayout(wave, { cell: 40, gap: 4, count: 10, height: 100 })
  assert.equal(layout.path[0], null) // before the first event
  assert.notEqual(layout.path[layout.path.length - 1], null)
  const flat = Tides.wave([ev(5, "high", 1), ev(8, "low", 1)], hoursFrom(5, 4))
  const l = Tides.waveLayout(flat, { cell: 40, gap: 4, count: 4, height: 100 })
  const ys = new Set(l.path.filter(p => p !== null).map(p => p.y))
  assert.equal(ys.size, 1)
  const y = [...ys][0]
  assert.ok(y > Tides.WAVE_BAND_TOP * 100 && y < Tides.WAVE_BAND_BOTTOM * 100)
})

test("the layout refuses a missing wave or an unusable size", () => {
  assert.equal(Tides.waveLayout(null, { cell: 40, gap: 4, count: 10, height: 100 }), null)
  const wave = Tides.wave(SWING, hoursFrom(5, 10))
  for (const bad of [null, {}, { cell: 0, gap: 4, count: 10, height: 100 }, { cell: 40, gap: 4, count: 10, height: 0 },
    { cell: NaN, gap: 4, count: 10, height: 100 }]) {
    assert.equal(Tides.waveLayout(wave, bad), null, JSON.stringify(bad))
  }
})

// ---- when to fetch: whenever the open forecast view has a station to show ------

const ready = () => ({ opened: true, view: "forecast", key: "noaa:9414290", cacheLoaded: true, running: false,
  retryAt: 0, cache: Tides.parseCache(""), now: NOW })

test("the panel opening on the forecast view with a station and no cached tides fetches", () => {
  assert.equal(Tides.wantsFetch(ready()), true)
})

test("it fetches without any day card being open", () => {
  // There is no day card in the state at all; opening the forecast is enough.
  assert.equal("detail" in ready(), false)
  assert.equal(Tides.wantsFetch(ready()), true)
})

test("no fetch while the panel is closed or showing settings", () => {
  assert.equal(Tides.wantsFetch(Object.assign(ready(), { opened: false })), false)
  assert.equal(Tides.wantsFetch(Object.assign(ready(), { view: "settings" })), false)
})

test("no fetch when tides are inactive: no station means an empty key", () => {
  for (const key of ["", null, undefined]) assert.equal(Tides.wantsFetch(Object.assign(ready(), { key })), false)
})

test("no fetch while the cache is fresh, one fetch once it is a day old", () => {
  const cache = Tides.withEntry(Tides.parseCache(""), "noaa:9414290", [{ time: 1, type: "high", height: 1 }], NOW - 3 * HOUR)
  assert.equal(Tides.wantsFetch(Object.assign(ready(), { cache })), false)
  assert.equal(Tides.wantsFetch(Object.assign(ready(), { cache, now: NOW + 20 * HOUR })), false)
  assert.equal(Tides.wantsFetch(Object.assign(ready(), { cache, now: NOW + 21 * HOUR })), true)
  const other = Tides.withEntry(Tides.parseCache(""), "dfo:123", [], NOW)
  assert.equal(Tides.wantsFetch(Object.assign(ready(), { cache: other })), true)
})

test("no fetch before the cache file has been read, while one is running, or during back-off", () => {
  assert.equal(Tides.wantsFetch(Object.assign(ready(), { cacheLoaded: false })), false)
  assert.equal(Tides.wantsFetch(Object.assign(ready(), { running: true })), false)
  assert.equal(Tides.wantsFetch(Object.assign(ready(), { retryAt: NOW + 1 })), false)
  assert.equal(Tides.wantsFetch(Object.assign(ready(), { retryAt: NOW })), true)
})

test("a malformed state never fetches", () => {
  for (const bad of [null, undefined, {}, [], 5, "x"]) assert.equal(Tides.wantsFetch(bad), false)
  assert.equal(Tides.wantsFetch(Object.assign(ready(), { now: NaN })), false)
  assert.equal(Tides.wantsFetch(Object.assign(ready(), { cache: null })), true)
})

// ---- the wave must read as a tide chart ------------------------------------------

const CDT = -5 * 3600 // Weeks Bay, Alabama, in October

test("the band's label names the tide and the station", () => {
  assert.equal(Tides.waveLabel({ name: "Weeks Bay" }), "TIDE · Weeks Bay")
  assert.equal(Tides.waveLabel({ name: "  Point Atkinson \n" }), "TIDE · Point Atkinson")
  for (const bad of [null, undefined, {}, { name: "" }, { name: "   " }, { name: 5 }, "Weeks Bay", []]) {
    assert.equal(Tides.waveLabel(bad), "TIDE", JSON.stringify(bad))
  }
  assert.equal(Tides.waveLabel({ name: "a\u0000b\u001fc" }), "TIDE · abc")
  assert.ok(Tides.waveLabel({ name: "x".repeat(200) }).length <= 48)
})

test("an event label is H or L and the time in the chosen clock", () => {
  const high = Date.UTC(2026, 9, 5, 10, 37)
  const low = Date.UTC(2026, 9, 6, 2, 34)
  assert.equal(Tides.markLabel("high", high, CDT, true), "H 5:37 AM")
  assert.equal(Tides.markLabel("low", low, CDT, true), "L 9:34 PM")
  assert.equal(Tides.markLabel("high", high, CDT, false), "H 05:37")
  assert.equal(Tides.markLabel("low", low, CDT, false), "L 21:34")
})

test("an event label follows the zone's wall clock across a clock change", () => {
  const zone = nyZone()
  assert.equal(Tides.markLabel("high", Date.UTC(2026, 10, 1, 5, 30), zone, false), "H 01:30")
  assert.equal(Tides.markLabel("low", Date.UTC(2026, 10, 1, 6, 30), zone, false), "L 01:30")
  assert.equal(Tides.markLabel("low", Date.UTC(2026, 10, 1, 6, 30), zone, true), "L 1:30 AM")
})

test("a label that cannot be made is empty, not a wrong time", () => {
  for (const [type, ms, zone] of [["tide", 1, 0], ["high", NaN, 0], ["high", "x", 0], ["low", 1, "x"], [null, 1, 0]]) {
    assert.equal(Tides.markLabel(type, ms, zone, true), "", JSON.stringify([type, ms, zone]))
  }
})

test("marks carry their instant, and each gets a placed text label for both clocks", () => {
  const events = Tides.PROVIDERS.noaa.parse(fixture("noaa-8765148-gmt.json"))
  // The hourly strip from 06:00 to 21:00 local (11:00Z to 02:00Z).
  const axis = Array.from({ length: 16 }, (_, i) => Date.UTC(2026, 9, 5, 11 + i))
  const wave = Tides.wave(events, axis)
  assert.deepEqual(wave.marks.map(m => m.ms), [Date.UTC(2026, 9, 5, 10, 37)])
  const layout = Tides.waveLayout(wave, { cell: 40, gap: 4, count: 16, height: 100 })
  const twelve = Tides.waveMarkViews(wave, layout, CDT, true)
  assert.deepEqual(twelve.map(v => [v.text, v.type, v.x, v.y]), [["H 5:37 AM", "high", layout.marks[0].x, layout.marks[0].y]])
  assert.deepEqual(Tides.waveMarkViews(wave, layout, CDT, false).map(v => v.text), ["H 05:37"])
})

test("every high and low in the visible hours is labelled", () => {
  const events = [ev(0, "low", 0), ev(6, "high", 2), ev(12, "low", 0), ev(18, "high", 2)]
  const axis = hoursFrom(1, 20)
  const wave = Tides.wave(events, axis)
  const layout = Tides.waveLayout(wave, { cell: 40, gap: 4, count: 20, height: 100 })
  const views = Tides.waveMarkViews(wave, layout, 0, false)
  assert.deepEqual(views.map(v => v.text), ["H 06:00", "L 12:00", "H 18:00"])
  assert.deepEqual(views.map(v => v.type), ["high", "low", "high"])
})

test("no views without a wave or a layout", () => {
  assert.deepEqual(Tides.waveMarkViews(null, null, 0, false), [])
  const wave = Tides.wave(SWING, hoursFrom(5, 10))
  assert.deepEqual(Tides.waveMarkViews(wave, null, 0, false), [])
  assert.deepEqual(Tides.waveMarkViews(null, { path: [], marks: [] }, 0, false), [])
})

test("the band takes height only when there is a wave to draw", () => {
  const wave = Tides.wave(SWING, hoursFrom(5, 10))
  assert.equal(Tides.waveBandHeight(wave, 16, 64), 80)
  for (const none of [null, undefined, {}, 5]) assert.equal(Tides.waveBandHeight(none, 16, 64), 0)
  // No interpolable interval in the visible hours: no wave, so no band.
  assert.equal(Tides.waveBandHeight(Tides.wave(SWING, hoursFrom(20, 3)), 16, 64), 0)
  assert.equal(Tides.waveBandHeight(Tides.wave([], hoursFrom(5, 10)), 16, 64), 0)
  assert.equal(Tides.waveBandHeight(Tides.wave([ev(0, "high", 2), ev(10, "high", 1)], hoursFrom(1, 8)), 16, 64), 0)
  for (const bad of [[NaN, 64], [16, -1], ["16", 64], [16, undefined]]) assert.equal(Tides.waveBandHeight(wave, bad[0], bad[1]), 0)
})

test("the chart keeps room above the highs and below the lows for their labels", () => {
  assert.ok(Tides.WAVE_BAND_TOP >= 0.25 && Tides.WAVE_BAND_BOTTOM <= 0.75 && Tides.WAVE_BAND_BOTTOM > Tides.WAVE_BAND_TOP)
})
