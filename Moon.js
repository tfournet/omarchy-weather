// Moon phase, illumination, moonrise and moonset, computed locally from the
// date and coordinates. No network.
//
// The astronomy (moonCoords, sunCoords, moonAltitude, riseSet) is a port of the
// moon functions in SunCalc by Vladimir Agafonkin, BSD-2-Clause; see NOTICE.md.
// It is a low-precision model, good to a few minutes for rise and set.
.pragma library
.import "Model.js" as Model

var RAD = Math.PI / 180
var DAY_MS = 86400000
var J1970 = 2440588
var J2000 = 2451545
var OBLIQUITY = RAD * 23.4397

var NAMES = ["New Moon", "Waxing Crescent", "First Quarter", "Waxing Gibbous",
  "Full Moon", "Waning Gibbous", "Last Quarter", "Waning Crescent"]
// Material Design moon glyphs, in the order of NAMES, as seen from the northern
// hemisphere. Checked against the panel font by test/glyph-coverage.py.
var GLYPHS = ["󰽤", "󰽧", "󰽡", "󰽨", "󰽢", "󰽦", "󰽣", "󰽥"]

var CACHE_LIMIT = 128
var cache = {}
var cacheCount = 0

function toDays(ms) {
  return ms / DAY_MS - 0.5 + J1970 - J2000
}

function rightAscension(l, b) {
  return Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY) - Math.tan(b) * Math.sin(OBLIQUITY), Math.cos(l))
}

function declination(l, b) {
  return Math.asin(Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l))
}

function sunCoords(d) {
  var M = RAD * (357.5291 + 0.98560028 * d)
  var C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M))
  var L = M + C + RAD * 102.9372 + Math.PI
  return { dec: declination(L, 0), ra: rightAscension(L, 0) }
}

function moonCoords(d) {
  var L = RAD * (218.316 + 13.176396 * d)
  var M = RAD * (134.963 + 13.064993 * d)
  var F = RAD * (93.272 + 13.229350 * d)
  var l = L + RAD * 6.289 * Math.sin(M)
  var b = RAD * 5.128 * Math.sin(F)
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: 385001 - 20905 * Math.cos(M) }
}

// Fraction of the disc lit (0..1) and position in the cycle (0 new, 0.5 full).
function illuminationAt(ms) {
  var d = toDays(ms)
  var s = sunCoords(d)
  var m = moonCoords(d)
  var sunDist = 149598000
  var phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra))
  var inc = Math.atan2(sunDist * Math.sin(phi), m.dist - sunDist * Math.cos(phi))
  var angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra),
    Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra))
  return { fraction: (1 + Math.cos(inc)) / 2, phase: 0.5 + 0.5 * inc * (angle < 0 ? -1 : 1) / Math.PI }
}

// New, quarter and full names cover the day or so around the exact moment;
// the stretches between are crescent and gibbous. Rounding to the nearest
// eighth instead would call a 33%-lit moon a Last Quarter.
function phaseIndex(phase) {
  var p = ((phase % 1) + 1) % 1
  var quarter = Math.round(p * 4)
  if (Math.abs(p - quarter / 4) <= 0.035) return (quarter * 2) % 8
  return Math.floor(p * 4) * 2 + 1
}

function phaseName(phase) {
  return NAMES[phaseIndex(phase)]
}

// The lit side flips between hemispheres, so a southern observer sees the
// mirror image of the northern glyph for the same phase.
function glyph(phase, latitude) {
  var i = phaseIndex(phase)
  return GLYPHS[latitude < 0 ? (8 - i) % 8 : i]
}

// Moon altitude above the horizon in radians, with the refraction and
// semi-diameter allowance rise and set are measured against.
function moonAltitude(ms, latitude, longitude) {
  var lw = RAD * -longitude
  var phi = RAD * latitude
  var d = toDays(ms)
  var c = moonCoords(d)
  var H = RAD * (280.16 + 360.9856235 * d) - lw - c.ra
  var h = Math.asin(Math.sin(phi) * Math.sin(c.dec) + Math.cos(phi) * Math.cos(c.dec) * Math.cos(H))
  var above = h < 0 ? 0 : h
  return h + 0.0002967 / Math.tan(above + 0.00312536 / (above + 0.08901179))
}

// Rise and set within the 24 hours after startMs, as epoch ms, found by
// fitting a parabola through each pair of hours and looking for a zero.
function riseSet(startMs, latitude, longitude) {
  var hc = 0.133 * RAD
  var at = function(hours) { return moonAltitude(startMs + hours * 3600000, latitude, longitude) - hc }
  var h0 = at(0)
  var rise = null
  var set = null
  var ye = 0
  for (var i = 1; i <= 24; i += 2) {
    var h1 = at(i)
    var h2 = at(i + 1)
    var a = (h0 + h2) / 2 - h1
    var b = (h2 - h0) / 2
    var xe = -b / (2 * a)
    ye = (a * xe + b) * xe + h1
    var disc = b * b - 4 * a * h1
    var roots = 0
    var x1 = 0
    var x2 = 0
    if (disc >= 0) {
      var dx = Math.sqrt(disc) / (Math.abs(a) * 2)
      x1 = xe - dx
      x2 = xe + dx
      if (Math.abs(x1) <= 1) roots++
      if (Math.abs(x2) <= 1) roots++
      if (x1 < -1) x1 = x2
    }
    if (roots === 1) {
      if (h0 < 0) rise = i + x1
      else set = i + x1
    } else if (roots === 2) {
      rise = i + (ye < 0 ? x2 : x1)
      set = i + (ye < 0 ? x1 : x2)
    }
    if (rise !== null && set !== null) break
    h0 = h2
  }
  return {
    riseMs: rise === null ? null : startMs + rise * 3600000,
    setMs: set === null ? null : startMs + set * 3600000,
    alwaysUp: rise === null && set === null && ye > 0,
    alwaysDown: rise === null && set === null && ye <= 0
  }
}

function validNumber(v, min, max) {
  return typeof v === "number" && isFinite(v) && v >= min && v <= max
}

// Local midnight of "yyyy-mm-dd" as epoch ms, given the zone's offset from UTC.
function localMidnight(dateString, offsetSec) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof dateString === "string" ? dateString : "")
  if (!m) return null
  var y = Number(m[1])
  var mo = Number(m[2]) - 1
  var day = Number(m[3])
  var utc = Date.UTC(y, mo, day)
  var check = new Date(utc)
  if (check.getUTCMonth() !== mo || check.getUTCDate() !== day) return null
  return utc - offsetSec * 1000
}

// The numbers for one date at one place, cached per date and place so the
// ten-day strip and the day card never repeat the work. Null when the input
// is not a real date, place and offset.
function dayCore(dateString, latitude, longitude, offsetSec) {
  if (!validNumber(latitude, -90, 90) || !validNumber(longitude, -180, 180)) return null
  if (!validNumber(offsetSec, -86400, 86400)) return null
  var start = localMidnight(dateString, offsetSec)
  if (start === null) return null

  var key = dateString + "|" + latitude.toFixed(3) + "|" + longitude.toFixed(3) + "|" + offsetSec
  if (cache[key]) return cache[key]

  var lit = illuminationAt(start + DAY_MS / 2)
  var times = riseSet(start, latitude, longitude)
  var core = {
    phase: lit.phase,
    fraction: lit.fraction,
    latitude: latitude,
    offsetSec: offsetSec,
    riseMs: times.riseMs,
    setMs: times.setMs,
    alwaysUp: times.alwaysUp,
    alwaysDown: times.alwaysDown
  }
  if (cacheCount >= CACHE_LIMIT) {
    cache = {}
    cacheCount = 0
  }
  cache[key] = core
  cacheCount++
  return core
}

function cacheSize() {
  return cacheCount
}

// Wall-clock "HH:MM" in the location's zone, or "" when there is no event.
function clockAt(ms, offsetSec) {
  if (ms === null) return ""
  var minutes = Math.round((ms + offsetSec * 1000) / 60000)
  var inDay = ((minutes % 1440) + 1440) % 1440
  return Model.pad2(Math.floor(inDay / 60)) + ":" + Model.pad2(inDay % 60)
}

function eventText(core, ms, twelveHour) {
  if (core.alwaysUp) return "Up all day"
  if (core.alwaysDown) return "Down all day"
  var hhmm = clockAt(ms, core.offsetSec)
  return hhmm ? Model.formatClock(hhmm, twelveHour, false) : "—"
}

// What the day card and the ten-day strip show for one date.
function dayInfo(dateString, latitude, longitude, offsetSec, twelveHour) {
  var core = dayCore(dateString, latitude, longitude, offsetSec)
  if (!core) return null
  var rise = clockAt(core.riseMs, offsetSec)
  var set = clockAt(core.setMs, offsetSec)
  return {
    name: phaseName(core.phase),
    percent: Math.round(core.fraction * 100),
    glyph: glyph(core.phase, core.latitude),
    rise: rise ? Model.formatClock(rise, twelveHour, false) : "",
    set: set ? Model.formatClock(set, twelveHour, false) : "",
    status: core.alwaysUp ? "Up all day" : (core.alwaysDown ? "Down all day" : ""),
    riseText: eventText(core, core.riseMs, twelveHour),
    setText: eventText(core, core.setMs, twelveHour)
  }
}

// dayInfo for the place and zone the forecast itself was for (Open-Meteo
// echoes them back), so a moon can never describe a different place.
function reportDay(report, dateString, twelveHour) {
  if (!report || typeof report !== "object") return null
  return dayInfo(dateString, report.latitude, report.longitude, report.utc_offset_seconds, twelveHour)
}
