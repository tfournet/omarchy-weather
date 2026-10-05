// Time zones. Open-Meteo prints every time in a response in one fixed offset, so
// per-date wall clock comes from tz-transitions.json (generated from the system
// tz database by scripts/build-tz-transitions.py).
//
// Live check, 2026-10-05: forecast for Sydney with past_days=3 gave
// sunrise "2026-10-03T06:30" and "2026-10-04T06:28" with utc_offset_seconds
// 39600 -- the real sunrise on Oct 3 (UTC+10) is about 05:30, so the response
// does not follow the daylight-saving change that happened on Oct 4.

const { test } = require("node:test")
const assert = require("node:assert/strict")
const { readFileSync, statSync } = require("node:fs")
const { join } = require("node:path")
const { loadLibrary } = require("./load.js")

const Zone = loadLibrary("Zone.js")

const TABLE_PATH = join(__dirname, "..", "tz-transitions.json")
const table = () => Zone.parseTable(readFileSync(TABLE_PATH, "utf8"))
const H = 3600 * 1000

function newYork() {
  const report = { timezone: "America/New_York", utc_offset_seconds: -14400 }
  return Zone.forReport(report, table(), Date.UTC(2026, 9, 26))
}

test("the table is small and parses to named zones", () => {
  assert.ok(statSync(TABLE_PATH).size < 80 * 1024)
  const zones = table()
  assert.ok(zones["America/New_York"] && zones["Australia/Sydney"] && zones["Europe/London"])
  assert.equal(zones["Asia/Kathmandu"], undefined)
})

test("US daylight-saving ends on Nov 1 2026 at 06:00 UTC", () => {
  const zone = newYork()
  assert.equal(Zone.offsetAt(zone, Date.UTC(2026, 10, 1, 5, 59)), -14400)
  assert.equal(Zone.offsetAt(zone, Date.UTC(2026, 10, 1, 6, 0)), -18000)
  assert.equal(Zone.offsetAt(zone, Date.UTC(2026, 9, 26)), -14400)
  assert.equal(Zone.offsetAt(zone, Date.UTC(2026, 11, 25)), -18000)
})

test("a southern zone springs forward on Oct 4 2026 and Lord Howe moves by half an hour", () => {
  const syd = Zone.forReport({ timezone: "Australia/Sydney", utc_offset_seconds: 39600 }, table(), Date.UTC(2026, 9, 5))
  assert.equal(Zone.offsetAt(syd, Date.UTC(2026, 9, 3, 15, 59)), 36000)
  assert.equal(Zone.offsetAt(syd, Date.UTC(2026, 9, 3, 16, 0)), 39600)
  const lh = Zone.forReport({ timezone: "Australia/Lord_Howe", utc_offset_seconds: 39600 }, table(), Date.UTC(2026, 9, 5))
  assert.equal(Zone.offsetAt(lh, Date.UTC(2026, 6, 1)), 37800)
})

test("midnight of a date uses the offset in force then, and day lengths follow", () => {
  const zone = newYork()
  assert.equal(Zone.midnight(zone, "2026-10-26"), Date.UTC(2026, 9, 26, 4))
  assert.equal(Zone.midnight(zone, "2026-11-01"), Date.UTC(2026, 10, 1, 4))
  assert.equal(Zone.midnight(zone, "2026-11-02"), Date.UTC(2026, 10, 2, 5))
  // Nov 1 is 25 hours long.
  assert.equal((Zone.midnight(zone, "2026-11-02") - Zone.midnight(zone, "2026-11-01")) / H, 25)
  assert.equal((Zone.midnight(zone, "2026-03-09") - Zone.midnight(zone, "2026-03-08")) / H, 23)
})

test("clock reads the wall time at that instant, across the change", () => {
  const zone = newYork()
  assert.equal(Zone.clock(zone, Date.UTC(2026, 10, 2, 4, 30)), "23:30")
  assert.equal(Zone.clock(zone, Date.UTC(2026, 10, 1, 4, 30)), "00:30")
  assert.equal(Zone.clock(zone, Date.UTC(2026, 10, 1, 6, 30)), "01:30")
})

test("the response's own offset is used when the zone is unknown, absent or stale", () => {
  const report = { timezone: "Asia/Kathmandu", utc_offset_seconds: 20700 }
  const zone = Zone.forReport(report, table(), Date.UTC(2026, 9, 5))
  assert.equal(Zone.offsetAt(zone, Date.UTC(2026, 11, 1)), 20700)
  for (const r of [{ utc_offset_seconds: -14400 }, { timezone: "Nowhere/Land", utc_offset_seconds: -14400 },
    { timezone: 5, utc_offset_seconds: -14400 }, { timezone: "../../etc/passwd", utc_offset_seconds: -14400 }]) {
    assert.equal(Zone.offsetAt(Zone.forReport(r, table(), Date.UTC(2026, 9, 5)), Date.UTC(2026, 10, 2)), -14400)
  }
  // A table that disagrees with the response about the current offset is not trusted.
  const wrong = Zone.forReport({ timezone: "America/New_York", utc_offset_seconds: -3600 }, table(), Date.UTC(2026, 9, 5))
  assert.equal(Zone.offsetAt(wrong, Date.UTC(2026, 10, 2)), -3600)
})

test("no usable offset means no zone", () => {
  for (const bad of [null, undefined, {}, { utc_offset_seconds: "x" }, { utc_offset_seconds: NaN }, { utc_offset_seconds: 1e9 }]) {
    assert.equal(Zone.forReport(bad, table(), 0), null, JSON.stringify(bad))
    assert.equal(Zone.of(bad), null)
  }
})

test("a zone is made from a number, or passed through", () => {
  assert.equal(Zone.offsetAt(Zone.normalize(-21600), 0), -21600)
  const z = newYork()
  assert.equal(Zone.normalize(z), z)
  for (const bad of ["x", NaN, null, {}, { base: "1", transitions: [] }, 1e9]) assert.equal(Zone.normalize(bad), null)
})

test("a report carries its zone, and Zone.of finds it or falls back to the fixed offset", () => {
  const report = { timezone: "America/New_York", utc_offset_seconds: -14400, latitude: 40.7 }
  const zoned = Zone.attach(report, newYork())
  assert.equal(Zone.of(zoned), zoned.zone)
  assert.equal(zoned.latitude, 40.7)
  assert.equal(report.zone, undefined)
  assert.equal(Zone.offsetAt(Zone.of(report), Date.UTC(2026, 10, 2)), -14400)
  assert.equal(Zone.attach(null, newYork()), null)
})

test("a malformed table parses to nothing, and bad rows are dropped", () => {
  for (const bad of ["", "nope", "null", "[]", "{}", '{"zones":[]}', '{"zones":"x"}']) assert.deepEqual(Zone.parseTable(bad), {})
  const dirty = JSON.stringify({ zones: {
    "A/Good": [0, 100, 3600],
    "B/Odd": [0, 100],
    "C/String": [0, "100", 3600],
    "D/Huge": [0, 100, 1e9],
    "E/Unsorted": [0, 200, 3600, 100, 0],
    "bad name!": [0, 100, 3600],
    "F/Null": null
  } })
  assert.deepEqual(Object.keys(Zone.parseTable(dirty)), ["A/Good"])
})

test("a file URL becomes a path", () => {
  assert.equal(Zone.localPath("file:///home/tim/.config/omarchy/plugins/x/tz-transitions.json"),
    "/home/tim/.config/omarchy/plugins/x/tz-transitions.json")
  assert.equal(Zone.localPath("file:///a%20b/c.json"), "/a b/c.json")
  assert.equal(Zone.localPath("/already/a/path.json"), "/already/a/path.json")
  assert.equal(Zone.localPath("file:///bad%zz"), "")
  assert.equal(Zone.localPath(""), "")
  assert.equal(Zone.localPath(null), "")
})

test("next date rolls month and year", () => {
  assert.equal(Zone.nextDate("2026-10-31"), "2026-11-01")
  assert.equal(Zone.nextDate("2026-12-31"), "2027-01-01")
  assert.equal(Zone.nextDate("2028-02-28"), "2028-02-29")
  assert.equal(Zone.nextDate("nope"), null)
})
