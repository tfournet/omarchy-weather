// Time zones for the forecast place.
//
// Open-Meteo writes every time in a response in one fixed offset, the one in
// force when it was fetched, even when the days it covers cross a daylight-saving
// change. So the wall clock on each date comes from tz-transitions.json
// (scripts/build-tz-transitions.py) looked up by the response's IANA `timezone`.
// A zone that is not in the table, or that the table contradicts, keeps the
// response's single offset.
//
// A zone is { before, transitions: [{ utc, offset }], key }: `before` is the
// offset ahead of the first transition, offsets are seconds east of UTC, `utc`
// is epoch ms, and `key` names it for caches.
.pragma library

var DAY_MS = 86400000
var MAX_OFFSET = 86400
var ZONE_NAME = /^[A-Za-z0-9_+\-]+(\/[A-Za-z0-9_+\-]+){0,2}$/

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function validOffset(v) {
  return typeof v === "number" && isFinite(v) && v >= -MAX_OFFSET && v <= MAX_OFFSET
}

function fixed(offsetSec) {
  if (!validOffset(offsetSec)) return null
  return { before: offsetSec, transitions: [], key: "f" + offsetSec }
}

function normalize(zoneOrOffset) {
  if (typeof zoneOrOffset === "number") return fixed(zoneOrOffset)
  if (isObject(zoneOrOffset) && validOffset(zoneOrOffset.before) && Array.isArray(zoneOrOffset.transitions)
      && typeof zoneOrOffset.key === "string") return zoneOrOffset
  return null
}

function offsetAt(zoneOrOffset, ms) {
  var zone = normalize(zoneOrOffset)
  if (zone === null) return null
  var offset = zone.before
  for (var i = 0; i < zone.transitions.length; i++) {
    if (zone.transitions[i].utc > ms) break
    offset = zone.transitions[i].offset
  }
  return offset
}

// tz-transitions.json text -> { "Zone/Name": { before, transitions, key } }.
// Rows that are not well-formed are dropped.
function parseTable(text) {
  var out = {}
  var body
  try {
    body = JSON.parse(String(text))
  } catch (e) {
    return out
  }
  if (!isObject(body) || !isObject(body.zones)) return out
  for (var name in body.zones) {
    var row = body.zones[name]
    if (!ZONE_NAME.test(name) || !Array.isArray(row) || row.length < 3 || row.length % 2 === 0) continue
    var ok = validOffset(row[0])
    var transitions = []
    var last = -Infinity
    for (var i = 1; ok && i < row.length; i += 2) {
      var minute = row[i]
      var offset = row[i + 1]
      if (typeof minute !== "number" || !isFinite(minute) || minute <= last || !validOffset(offset)) ok = false
      else transitions.push({ utc: minute * 60000, offset: offset })
      last = minute
    }
    if (ok) out[name] = { before: row[0], transitions: transitions, key: name + "|" + row.length + "|" + row[1] }
  }
  return out
}

// The zone for a forecast report. The table is used only when it knows the
// report's `timezone` and agrees with the report's own offset at `nowMs`;
// otherwise the report's single offset stands. Null if the report has none.
function forReport(report, table, nowMs) {
  if (!isObject(report) || !validOffset(report.utc_offset_seconds)) return null
  var plain = fixed(report.utc_offset_seconds)
  var name = report.timezone
  if (typeof name !== "string" || !ZONE_NAME.test(name) || !isObject(table) || !table.hasOwnProperty(name)) return plain
  var zone = table[name]
  return offsetAt(zone, nowMs) === report.utc_offset_seconds ? zone : plain
}

// A copy of the report that carries its zone.
function attach(report, zone) {
  if (!isObject(report)) return null
  var copy = {}
  for (var key in report) copy[key] = report[key]
  copy.zone = zone
  return copy
}

// The report's zone: the attached one, or its single offset.
function of(report) {
  if (!isObject(report)) return null
  return normalize(report.zone) || fixed(report.utc_offset_seconds)
}

// A QML file URL as a filesystem path ("" if it cannot be one).
function localPath(url) {
  if (typeof url !== "string") return ""
  if (url.indexOf("file://") !== 0) return url
  try {
    return decodeURIComponent(url.slice(7))
  } catch (e) {
    return ""
  }
}

function parseDate(dateString) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof dateString === "string" ? dateString : "")
  if (!m) return null
  var utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  var back = new Date(utc)
  if (back.getUTCMonth() !== Number(m[2]) - 1 || back.getUTCDate() !== Number(m[3])) return null
  return utc
}

function nextDate(dateString) {
  var utc = parseDate(dateString)
  if (utc === null) return null
  var d = new Date(utc + DAY_MS)
  return d.getUTCFullYear() + "-" + (d.getUTCMonth() < 9 ? "0" : "") + (d.getUTCMonth() + 1)
    + "-" + (d.getUTCDate() < 10 ? "0" : "") + d.getUTCDate()
}

// The instant a local calendar date begins, as epoch ms; null for a bad date or zone.
function midnight(zoneOrOffset, dateString) {
  var zone = normalize(zoneOrOffset)
  var utc = parseDate(dateString)
  if (zone === null || utc === null) return null
  var guess = utc - offsetAt(zone, utc - zone.before * 1000) * 1000
  return utc - offsetAt(zone, guess) * 1000
}

// "HH:MM" on the wall clock at an instant, rounded to the minute.
function clock(zoneOrOffset, ms) {
  var offset = offsetAt(zoneOrOffset, ms)
  if (offset === null || typeof ms !== "number" || !isFinite(ms)) return ""
  var minutes = Math.round((ms + offset * 1000) / 60000)
  var inDay = ((minutes % 1440) + 1440) % 1440
  var h = Math.floor(inDay / 60)
  var m = inDay % 60
  return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m
}
