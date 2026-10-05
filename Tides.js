// Tides: two provider adapters (NOAA CO-OPS for US coasts and territories,
// Canada's DFO IWLS), the nearest-station choice over the shipped index, the
// once-a-day cache, and the rows a day card shows.
//
// Everything here is pure. Responses and the cache file are downloaded or
// on-disk data, so a value is used only when it is a finite number of the
// expected shape; anything else is skipped, and a day with nothing shows a dash.
//
// An adapter has the same shape for both providers:
//   id, name, datum, attribution
//   request(stationId, fromMs, toMs) -> curl argv, or null if the id or range is unusable
//   parse(rawText)                   -> [{ time, type: "high"|"low", height }] or null
// `time` is epoch ms (UTC) and `height` is metres above the adapter's datum.
// Both providers are asked for UTC so no station time zone is ever guessed;
// the forecast's own offset places an event on a local day.
.pragma library
.import "Model.js" as Model
.import "Zone.js" as Zone

var MAX_TIDE_BYTES = 262144
var REQUEST_SECONDS = 8
var FEET_PER_METRE = 3.28084
var DAY_MS = 86400000
var REFETCH_MS = DAY_MS
var CLOCK_SKEW_MS = 6 * 3600000
var MAX_CACHED_STATIONS = 12
var CHOICE_LIMIT = 128
// Real tides give four or five turning points a day; a request spans about
// twelve days. Anything past these is not tide data, whatever a response says.
var MAX_PER_DAY = 6
var MAX_EVENTS = MAX_PER_DAY * 14

var KEY_PATTERN = /^(noaa|dfo):[A-Za-z0-9]+$/
var NOAA_ID = /^[A-Za-z0-9]{1,12}$/
var DFO_ID = /^[0-9a-f]{24}$/

var choiceCache = {}
var choiceCount = 0

function validTime(ms) {
  return typeof ms === "number" && isFinite(ms)
}

function validRange(fromMs, toMs) {
  return validTime(fromMs) && validTime(toMs) && toMs > fromMs
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function tryParse(raw) {
  try {
    return JSON.parse(String(raw))
  } catch (e) {
    return undefined
  }
}

// Sorted by time, repeats of the same time and type dropped, at most
// MAX_PER_DAY per UTC day and MAX_EVENTS in all. Applied to everything that is
// parsed, cached or drawn, so a hostile or broken response stays small.
function boundEvents(events) {
  var sorted = events.slice().sort(function(a, b) { return a.time - b.time })
  var seen = {}
  var perDay = {}
  var out = []
  for (var i = 0; i < sorted.length && out.length < MAX_EVENTS; i++) {
    var e = sorted[i]
    var key = e.time + "|" + (e.type || "")
    var day = Math.floor(e.time / DAY_MS)
    if (seen.hasOwnProperty(key) || (perDay[day] || 0) >= MAX_PER_DAY) continue
    seen[key] = true
    perDay[day] = (perDay[day] || 0) + 1
    out.push(e)
  }
  return out
}

// "yyyy-mm-dd hh:mm" (UTC) -> epoch ms, or null for anything that is not a real time.
function utcStamp(text) {
  var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(typeof text === "string" ? text : "")
  if (!m) return null
  var ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
  var back = new Date(ms)
  if (back.getUTCMonth() !== Number(m[2]) - 1 || back.getUTCDate() !== Number(m[3])) return null
  if (Number(m[4]) > 23 || Number(m[5]) > 59) return null
  return ms
}

function compactDate(ms) {
  var d = new Date(ms)
  return d.getUTCFullYear() + Model.pad2(d.getUTCMonth() + 1) + Model.pad2(d.getUTCDate())
}

function isoZ(ms) {
  var d = new Date(ms)
  return d.getUTCFullYear() + "-" + Model.pad2(d.getUTCMonth() + 1) + "-" + Model.pad2(d.getUTCDate())
    + "T" + Model.pad2(d.getUTCHours()) + ":" + Model.pad2(d.getUTCMinutes()) + ":" + Model.pad2(d.getUTCSeconds()) + "Z"
}

// ---- NOAA CO-OPS ----------------------------------------------------------

function noaaRequest(stationId, fromMs, toMs) {
  if (typeof stationId !== "string" || !NOAA_ID.test(stationId) || !validRange(fromMs, toMs)) return null
  var url = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
    + "?product=predictions&application=omarchy-detailed-weather"
    + "&station=" + encodeURIComponent(stationId)
    + "&begin_date=" + compactDate(fromMs) + "&end_date=" + compactDate(toMs)
    + "&datum=MLLW&time_zone=gmt&units=metric&interval=hilo&format=json"
  return Model.curlGet(url, REQUEST_SECONDS, MAX_TIDE_BYTES)
}

// NOAA answers an unknown station with HTTP 200 and an {"error": ...} body.
function noaaParse(raw) {
  var body = tryParse(raw)
  if (!isObject(body) || !Array.isArray(body.predictions)) return null
  var out = []
  for (var i = 0; i < body.predictions.length; i++) {
    var p = body.predictions[i]
    if (!isObject(p)) continue
    var time = utcStamp(p.t)
    var height = null
    if (typeof p.v === "number" && isFinite(p.v)) height = p.v
    else if (typeof p.v === "string" && /^-?\d+(\.\d+)?$/.test(p.v)) height = Number(p.v)
    var type = p.type === "H" ? "high" : (p.type === "L" ? "low" : "")
    if (time === null || height === null || !type) continue
    out.push({ time: time, type: type, height: height })
  }
  return boundEvents(out)
}

// ---- Canada DFO IWLS ----------------------------------------------------

function dfoRequest(stationId, fromMs, toMs) {
  if (typeof stationId !== "string" || !DFO_ID.test(stationId) || !validRange(fromMs, toMs)) return null
  var url = "https://api-iwls.dfo-mpo.gc.ca/api/v1/stations/" + encodeURIComponent(stationId)
    + "/data?time-series-code=wlp-hilo&from=" + isoZ(fromMs) + "&to=" + isoZ(toMs)
  return Model.curlGet(url, REQUEST_SECONDS, MAX_TIDE_BYTES)
}

// The wlp-hilo series is a list of turning points with no high/low flag. They
// alternate, so each is a high when it is above the one after it; the last
// takes the opposite of the one before. One lone point cannot be told apart.
function dfoParse(raw) {
  var body = tryParse(raw)
  if (!Array.isArray(body)) return null
  var points = []
  for (var i = 0; i < body.length; i++) {
    var e = body[i]
    if (!isObject(e) || typeof e.value !== "number" || !isFinite(e.value)) continue
    if (typeof e.eventDate !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z$/.test(e.eventDate)) continue
    var time = Date.parse(e.eventDate)
    if (!isFinite(time)) continue
    points.push({ time: time, height: e.value })
  }
  points = boundEvents(points)
  if (points.length < 2) return []
  var out = []
  for (var j = 0; j < points.length; j++) {
    var high
    if (j < points.length - 1) high = points[j].height > points[j + 1].height
    else high = out[j - 1].type === "low"
    out.push({ time: points[j].time, type: high ? "high" : "low", height: points[j].height })
  }
  return out
}

var PROVIDERS = {
  noaa: {
    id: "noaa",
    name: "NOAA CO-OPS",
    datum: "MLLW",
    attribution: "NOAA CO-OPS",
    request: noaaRequest,
    parse: noaaParse
  },
  dfo: {
    id: "dfo",
    name: "Canadian Hydrographic Service",
    datum: "Chart Datum",
    attribution: "Canadian Hydrographic Service, Fisheries and Oceans Canada",
    request: dfoRequest,
    parse: dfoParse
  }
}

// ---- Station index ------------------------------------------------------

function validPlace(lat, lon) {
  return typeof lat === "number" && isFinite(lat) && lat >= -90 && lat <= 90
    && typeof lon === "number" && isFinite(lon) && lon >= -180 && lon <= 180
}

// tide-stations.json -> [{ provider, id, name, lat, lon }]. Rows that do not
// look like a station of their provider are dropped.
function parseIndex(text) {
  var body = tryParse(text)
  if (!isObject(body)) return []
  var out = []
  for (var provider in PROVIDERS) {
    var rows = body[provider]
    if (!Array.isArray(rows)) continue
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i]
      if (!Array.isArray(r) || r.length < 4) continue
      if (typeof r[0] !== "string" || typeof r[1] !== "string" || r[1] === "") continue
      if (PROVIDERS[provider].request(r[0], 0, 1) === null || !validPlace(r[2], r[3])) continue
      out.push({ provider: provider, id: r[0], name: r[1], lat: r[2], lon: r[3] })
    }
  }
  return out
}

function distanceKm(lat1, lon1, lat2, lon2) {
  var rad = Math.PI / 180
  var dLat = (lat2 - lat1) * rad
  var dLon = (lon2 - lon1) * rad
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// The one `tides` setting. In auto a station shows only when it is within
// AUTO_MAX_KM of the forecast location; on uses the nearest at any distance;
// off never shows one. Not a setting itself: Tim chose 100 km.
var AUTO_MAX_KM = 100
var MODES = ["auto", "on", "off"]

// The setting's value, or "auto" for anything that is not one of the three.
function normalizeMode(value) {
  return typeof value === "string" && MODES.indexOf(value) >= 0 ? value : "auto"
}

// The station nearest a place within maxKm (Infinity for no limit):
// { station, km } or null.
function nearestStation(stations, lat, lon, maxKm) {
  if (!Array.isArray(stations) || !validPlace(lat, lon)) return null
  if (typeof maxKm !== "number" || isNaN(maxKm) || maxKm < 0) return null
  var best = null
  var bestKm = Infinity
  for (var i = 0; i < stations.length; i++) {
    var km = distanceKm(lat, lon, stations[i].lat, stations[i].lon)
    if (km < bestKm) {
      best = stations[i]
      bestKm = km
    }
  }
  return best !== null && bestKm <= maxKm ? { station: best, km: bestKm } : null
}

// The station to show for a place under the `tides` setting, or null (off, no
// station in range in auto, or none in the index). Remembered per place and
// mode, so a location change is looked up once and "no station" is remembered
// too. The lookup is local and cheap, so auto runs it for every place.
function stationFor(stations, lat, lon, mode) {
  if (!Array.isArray(stations) || !validPlace(lat, lon)) return null
  var m = normalizeMode(mode)
  if (m === "off") return null
  // The exact coordinates, not rounded ones: two places a few metres apart can
  // be on either side of the auto threshold and must not share an answer.
  var key = lat + "|" + lon + "|" + m + "|" + stations.length
  if (choiceCache.hasOwnProperty(key)) return choiceCache[key]
  var found = nearestStation(stations, lat, lon, m === "on" ? Infinity : AUTO_MAX_KM)
  if (choiceCount >= CHOICE_LIMIT) {
    choiceCache = {}
    choiceCount = 0
  }
  choiceCache[key] = found
  choiceCount++
  return found
}

function choiceCacheSize() {
  return choiceCount
}

// ---- Cache of fetched predictions ----------------------------------------

function validEvent(e) {
  return isObject(e) && validTime(e.time) && (e.type === "high" || e.type === "low")
    && typeof e.height === "number" && isFinite(e.height)
}

// The cache file as text -> { version, stations: { "noaa:123": { fetchedAt, events } } }.
// Whatever does not check out is left out, so a damaged file is an empty cache.
function parseCache(text) {
  var cache = { version: 1, stations: {} }
  var body = tryParse(text)
  if (!isObject(body) || !isObject(body.stations)) return cache
  for (var key in body.stations) {
    var entry = body.stations[key]
    if (!KEY_PATTERN.test(key) || !isObject(entry) || !validTime(entry.fetchedAt) || !Array.isArray(entry.events)) continue
    var events = []
    for (var i = 0; i < entry.events.length; i++) {
      if (validEvent(entry.events[i])) {
        var e = entry.events[i]
        events.push({ time: e.time, type: e.type, height: e.height })
      }
    }
    cache.stations[key] = { fetchedAt: entry.fetchedAt, events: boundEvents(events) }
  }
  return cache
}

function serializeCache(cache) {
  return JSON.stringify(cache) + "\n"
}

function eventsFor(cache, key) {
  if (!cache || !isObject(cache.stations) || !cache.stations.hasOwnProperty(key)) return null
  return cache.stations[key].events
}

// Predictions do not change, so a station is fetched at most once a day. An
// entry stamped well in the future (a wrong clock, a hand-edited file) is not
// trusted.
function needsFetch(cache, key, nowMs) {
  if (!cache || !isObject(cache.stations) || !cache.stations.hasOwnProperty(key)) return true
  var age = nowMs - cache.stations[key].fetchedAt
  return age >= REFETCH_MS || age < -CLOCK_SKEW_MS
}

// A copy of the cache with this station's entry replaced, keeping only the
// most recently fetched stations.
function withEntry(cache, key, events, nowMs) {
  var next = { version: 1, stations: {} }
  if (!KEY_PATTERN.test(key)) return cache
  if (cache && isObject(cache.stations)) {
    for (var k in cache.stations) next.stations[k] = cache.stations[k]
  }
  next.stations[key] = { fetchedAt: nowMs, events: boundEvents(events) }

  var keys = Object.keys(next.stations).sort(function(a, b) {
    return next.stations[b].fetchedAt - next.stations[a].fetchedAt
  })
  for (var i = MAX_CACHED_STATIONS; i < keys.length; i++) delete next.stations[keys[i]]
  return next
}

// A response answers the question that was asked, not whichever station is
// wanted by the time it lands.
function isCurrent(request, wantedKey) {
  return isObject(request) && typeof request.key === "string" && request.key !== "" && request.key === wantedKey
}

// ---- Window and paths -----------------------------------------------------

// UTC range covering every forecast day in the forecast's zone (each end at the
// offset in force there), with a day before and after.
function windowFor(report) {
  if (!isObject(report) || !isObject(report.daily) || !Array.isArray(report.daily.time) || report.daily.time.length < 1) return null
  var zone = Zone.of(report)
  if (zone === null) return null
  var first = Zone.midnight(zone, report.daily.time[0])
  var last = Zone.midnight(zone, report.daily.time[report.daily.time.length - 1])
  if (first === null || last === null) return null
  return { fromMs: first - DAY_MS, toMs: last + 2 * DAY_MS }
}

// ---- Display ----------------------------------------------------------------

function clock(ms, zoneOrOffset) {
  return Zone.clock(zoneOrOffset, ms)
}

// Events on a local calendar day, in the zone given (a zone, or a fixed offset
// in seconds). A day is 23 or 25 hours long where the clocks change.
function dayEvents(events, dateString, zoneOrOffset) {
  if (!Array.isArray(events)) return []
  var start = Zone.midnight(zoneOrOffset, dateString)
  var end = Zone.midnight(zoneOrOffset, Zone.nextDate(dateString))
  if (start === null || end === null) return []
  var out = []
  for (var i = 0; i < events.length; i++) {
    if (events[i].time >= start && events[i].time < end) out.push(events[i])
  }
  return out.slice(0, MAX_PER_DAY)
}

function formatHeight(metres, useImperial) {
  if (typeof metres !== "number" || !isFinite(metres)) return "—"
  var v = Math.round((useImperial ? metres * FEET_PER_METRE : metres) * 10) / 10
  if (v === 0) v = 0
  return v.toFixed(1) + (useImperial ? " ft" : " m")
}

function formatDistance(km, useImperial) {
  if (typeof km !== "number" || !isFinite(km) || km < 0) return ""
  var v = useImperial ? km * 0.621371 : km
  return (v < 10 ? v.toFixed(1) : String(Math.round(v))) + (useImperial ? " mi" : " km")
}

// What the day card shows for tides, or null when there is no station to show.
// info: { station, distanceKm, events }; events is null until they have loaded.
function dayTides(info, dateString, zoneOrOffset, useImperial, twelveHour) {
  if (!isObject(info) || !isObject(info.station) || !PROVIDERS.hasOwnProperty(info.station.provider)) return null
  if (Zone.normalize(zoneOrOffset) === null) return null
  if (Zone.midnight(0, dateString) === null) return null

  var provider = PROVIDERS[info.station.provider]
  var day = dayEvents(info.events, dateString, zoneOrOffset)
  var rows = []
  for (var i = 0; i < day.length; i++) {
    var time = Model.formatClock(clock(day[i].time, zoneOrOffset), twelveHour, false)
    var height = formatHeight(day[i].height, useImperial)
    rows.push({
      key: "tide" + i,
      label: day[i].type === "high" ? "High" : "Low",
      time: time,
      height: height,
      value: time + " · " + height
    })
  }
  if (rows.length === 0) rows.push({ key: "tides", label: "Tides", value: "—" })

  var distance = formatDistance(info.distanceKm, useImperial)
  return {
    rows: rows,
    station: info.station.name + (distance ? " · " + distance : ""),
    datum: "Heights above " + provider.datum,
    credit: "Source: " + provider.attribution
  }
}

// ---- The tide wave behind the hourly strip ---------------------------------

// Real tides give four or five turning points a day, 6 hours or so apart. A
// longer stretch between consecutive events means data is missing, and drawing
// a curve across it would invent one.
var MAX_WAVE_GAP_MS = 14 * 3600000
var HOUR_MS = 3600000
var WAVE_SAMPLES_PER_HOUR = 4
// The wave sits in the lower part of the strip: from 55% to 95% of its height.
var WAVE_BAND_TOP = 0.55
var WAVE_BAND_BOTTOM = 0.95

// The valid events, in time order.
function sortedEvents(events) {
  if (!Array.isArray(events)) return []
  var out = []
  for (var i = 0; i < events.length; i++) if (validEvent(events[i])) out.push(events[i])
  return out.sort(function(a, b) { return a.time - b.time })
}

// Height at ms between consecutive events by half-cosine interpolation,
//   h(t) = h0 + (h1 - h0) * (1 - cos(pi * (t - t0) / (t1 - t0))) / 2,
// the standard approximation: exact at each event, monotonic between a high
// and a low. Null before the first event, after the last, and across a gap of
// more than MAX_WAVE_GAP_MS.
function heightIn(sorted, ms) {
  for (var i = 0; i < sorted.length; i++) {
    if (sorted[i].time === ms) return sorted[i].height
    if (sorted[i].time > ms) {
      if (i === 0) return null
      var a = sorted[i - 1]
      var b = sorted[i]
      if (b.time - a.time > MAX_WAVE_GAP_MS) return null
      return a.height + (b.height - a.height) * (1 - Math.cos(Math.PI * (ms - a.time) / (b.time - a.time))) / 2
    }
  }
  return null
}

function waveHeight(events, ms) {
  if (typeof ms !== "number" || !isFinite(ms)) return null
  return heightIn(sortedEvents(events), ms)
}

// The instants of the hours the strip shows, from the report's own hourly
// strings, which are written in the report's single offset. [] if any hour
// cannot be read.
function hourEpochs(report, hours) {
  if (!isObject(report) || !isObject(report.hourly) || !Array.isArray(report.hourly.time) || !Array.isArray(hours)) return []
  var offset = report.utc_offset_seconds
  if (typeof offset !== "number" || !isFinite(offset)) return []
  var out = []
  for (var i = 0; i < hours.length; i++) {
    var h = hours[i]
    var stamp = isObject(h) && typeof h.reportIndex === "number" ? report.hourly.time[h.reportIndex] : null
    var seconds = typeof stamp === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(stamp) ? Model.isoLocalToEpoch(stamp, offset) : 0
    if (!seconds) return []
    out.push(seconds * 1000)
  }
  return out
}

// The wave over consecutive hours `hourMs`, covering half an hour either side
// of the first and last: samples at WAVE_SAMPLES_PER_HOUR a hour (fi is the
// position in hours from the first cell's centre, h the height or null where
// there is no curve), and a mark for each high or low inside the span. Null
// when the hours are not consecutive or no stretch of the span has a curve.
function wave(events, hourMs) {
  if (!Array.isArray(hourMs) || hourMs.length < 1) return null
  for (var i = 0; i < hourMs.length; i++) {
    if (typeof hourMs[i] !== "number" || !isFinite(hourMs[i]) || (i > 0 && hourMs[i] - hourMs[i - 1] !== HOUR_MS)) return null
  }
  var sorted = sortedEvents(events)
  var first = hourMs[0]
  var from = first - HOUR_MS / 2
  var to = hourMs[hourMs.length - 1] + HOUR_MS / 2
  var samples = []
  var drawn = false
  var steps = hourMs.length * WAVE_SAMPLES_PER_HOUR
  for (var k = 0; k <= steps; k++) {
    var fi = -0.5 + k / WAVE_SAMPLES_PER_HOUR
    var h = heightIn(sorted, first + fi * HOUR_MS)
    if (h !== null) drawn = true
    samples.push({ fi: fi, h: h })
  }
  if (!drawn) return null
  var marks = []
  for (var j = 0; j < sorted.length; j++) {
    if (sorted[j].time >= from && sorted[j].time <= to) {
      marks.push({ type: sorted[j].type, fi: (sorted[j].time - first) / HOUR_MS, h: sorted[j].height })
    }
  }
  return { fromMs: from, toMs: to, samples: samples, marks: marks }
}

// Pixel positions for a wave over a strip of `count` cells of width `cell` with
// `gap` between them and `height`. Heights are scaled to the visible span's own
// min and max, within the lower band of the strip. path holds {x, y} or null
// (a gap) per sample; marks hold {x, y, type}. Null for no wave or a bad size.
function waveLayout(waveData, size) {
  if (!isObject(waveData) || !isObject(size)) return null
  if (!(size.cell > 0) || !(size.gap >= 0) || !(size.count > 0) || !(size.height > 0)) return null
  var lo = Infinity
  var hi = -Infinity
  var i
  for (i = 0; i < waveData.samples.length; i++) {
    var h = waveData.samples[i].h
    if (h !== null) {
      lo = Math.min(lo, h)
      hi = Math.max(hi, h)
    }
  }
  for (i = 0; i < waveData.marks.length; i++) {
    lo = Math.min(lo, waveData.marks[i].h)
    hi = Math.max(hi, waveData.marks[i].h)
  }
  var top = size.height * WAVE_BAND_TOP
  var bottom = size.height * WAVE_BAND_BOTTOM
  var xOf = function(fi) { return fi * (size.cell + size.gap) + size.cell / 2 }
  var yOf = function(value) { return hi > lo ? top + (1 - (value - lo) / (hi - lo)) * (bottom - top) : (top + bottom) / 2 }
  var path = []
  for (i = 0; i < waveData.samples.length; i++) {
    var s = waveData.samples[i]
    path.push(s.h === null ? null : { x: xOf(s.fi), y: yOf(s.h) })
  }
  var marks = []
  for (i = 0; i < waveData.marks.length; i++) {
    marks.push({ x: xOf(waveData.marks[i].fi), y: yOf(waveData.marks[i].h), type: waveData.marks[i].type })
  }
  return { path: path, marks: marks }
}
