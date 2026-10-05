#!/usr/bin/env python3
"""Regenerate tz-transitions.json: when each IANA zone changes its UTC offset.

    scripts/build-tz-transitions.py [output-path]
    scripts/build-tz-transitions.py --check      # exit 1 if the committed file is stale

Open-Meteo writes every time in a response in ONE fixed offset (the one in force
when it was fetched), so a ten-day forecast that crosses a daylight-saving
change cannot say what the wall clock reads on each date. The panel looks the
zone up in this table instead. Only zones that change offset between START_YEAR
and END_YEAR are listed; a zone that is not listed keeps the response's offset.

Entry: "Zone/Name": [offset_before, minute_1, offset_1, minute_2, offset_2, ...]
Offsets are seconds east of UTC; minutes are minutes since the Unix epoch (UTC).
"""

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, available_timezones

START_YEAR = 2026
END_YEAR = 2032
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "tz-transitions.json"


def offset_at(zone, minute):
    moment = datetime.fromtimestamp(minute * 60, tz=timezone.utc).astimezone(zone)
    return int(moment.utcoffset().total_seconds())


def transitions(name):
    zone = ZoneInfo(name)
    start = int(datetime(START_YEAR, 1, 1, tzinfo=timezone.utc).timestamp() // 60)
    end = int(datetime(END_YEAR + 1, 1, 1, tzinfo=timezone.utc).timestamp() // 60)
    step = 6 * 60
    before = offset_at(zone, start)
    out = []
    previous, previous_offset = start, before
    for minute in range(start + step, end + step, step):
        current = offset_at(zone, minute)
        if current != previous_offset:
            low, high = previous, minute
            while high - low > 1:
                middle = (low + high) // 2
                if offset_at(zone, middle) == previous_offset:
                    low = middle
                else:
                    high = middle
            out += [high, current]
            previous_offset = current
        previous = minute
    return [before] + out if out else None


def build():
    table = {}
    for name in sorted(available_timezones()):
        try:
            row = transitions(name)
        except Exception:
            continue
        if row:
            table[name] = row
    return {"version": 1, "from": START_YEAR, "to": END_YEAR, "zones": table}


def main():
    text = json.dumps(build(), separators=(",", ":")) + "\n"
    if "--check" in sys.argv:
        current = DEFAULT_OUT.read_text(encoding="utf-8") if DEFAULT_OUT.exists() else ""
        if current != text:
            print("tz-transitions.json is out of date; run scripts/build-tz-transitions.py")
            return 1
        print("tz-transitions.json is up to date")
        return 0
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    out.write_text(text, encoding="utf-8")
    print("%s: %d zones, %d bytes" % (out, len(json.loads(text)["zones"]), len(text.encode())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
