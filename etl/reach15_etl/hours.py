"""OSM `opening_hours` parser for the common subset of the specification.

Turns a value such as ``Mo-Fr 08:00-20:00; Sa 08:00-14:00; Su,PH off`` into open intervals in
minutes of the week (0 = Monday 00:00, 10080 = the next Monday), the unit of analytics.poi_hours.

Supported: ``24/7``; weekday lists and ranges (``Mo,We``, ``Mo-Fr``, wrapping ``Sa-Mo``);
time lists (``08:00-12:00,13:00-17:00``), times past midnight (``22:00-02:00``, ``18:00-26:00``);
``off`` / ``closed``; ``||`` fallbacks (read as ``;``). Later rules replace earlier ones for the
days they name, as in the specification.

Public holidays (``PH``): rules that name ``PH`` (``PH off``, ``Su,PH 10:00-14:00``) give the
holiday hours, in minutes of the holiday (see ``parse_holiday``). A value that never names
``PH`` keeps its weekly hours on holidays, as the specification reads. School holidays (``SH``)
are not modelled: a rule that only names them is skipped.

Anything else (month or week selectors, sunrise/sunset, comments, open ends) returns None, which
the application treats as "hours unknown" rather than guessing.
"""

from __future__ import annotations

import re

DAY = 1440
WEEK = 7 * DAY
DAYS = ("Mo", "Tu", "We", "Th", "Fr", "Sa", "Su")
HOLIDAYS = ("PH", "SH")

_TIME_RANGE = re.compile(r"^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$")
_DAY_TOKEN = re.compile(r"^(Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$")

Interval = tuple[int, int]


class Unsupported(ValueError):
    """The value uses a part of the specification this parser does not model."""


def _days(selector: str) -> tuple[list[int], bool]:
    """Weekday indexes named by a selector, and whether it names public holidays (PH)."""
    days: list[int] = []
    public_holiday = False
    for token in selector.split(","):
        m = _DAY_TOKEN.match(token)
        if not m:
            raise Unsupported(f"weekday selector {token!r}")
        start, end = m.groups()
        if start in HOLIDAYS:
            if end:
                raise Unsupported(f"holiday range {token!r}")
            public_holiday = public_holiday or start == "PH"
            continue
        a = DAYS.index(start)
        b = DAYS.index(end) if end else a
        span = (b - a) % 7
        days += [(a + i) % 7 for i in range(span + 1)]
    return days, public_holiday


def _times(selector: str) -> list[Interval]:
    """Time ranges in minutes from the start of the day; the end may pass midnight."""
    out: list[Interval] = []
    for token in selector.split(","):
        m = _TIME_RANGE.match(token)
        if not m:
            raise Unsupported(f"time selector {token!r}")
        h1, m1, h2, m2 = (int(g) for g in m.groups())
        if m1 > 59 or m2 > 59 or h1 > 24 or h2 > 48:
            raise Unsupported(f"time {token!r}")
        start, end = h1 * 60 + m1, h2 * 60 + m2
        if end <= start:
            end += DAY  # 22:00-02:00 runs into the next day
        out.append((start, end))
    return out


def _is_days(token: str) -> bool:
    return all(_DAY_TOKEN.match(t) for t in token.split(","))


def parse(value: str | None) -> list[Interval] | None:
    """Open intervals in minutes of the week, merged and sorted; None if unsupported or empty."""
    parsed = parse_all(value)
    return parsed[0] if parsed else None


def parse_holiday(value: str | None) -> list[Interval] | None:
    """Open intervals on a public holiday, in minutes from its midnight (the end may pass
    midnight); [] if closed; None if the value does not name PH (weekly hours apply) or is
    unsupported."""
    parsed = parse_all(value)
    return parsed[1] if parsed else None


def parse_all(value: str | None) -> tuple[list[Interval], list[Interval] | None] | None:
    """(weekly intervals, holiday intervals or None); None if unsupported or empty."""
    if value is None or not value.strip():
        return None
    try:
        return _parse(value)
    except Unsupported:
        return None


def _parse(value: str) -> tuple[list[Interval], list[Interval] | None]:
    # Day of the week -> intervals relative to that day's midnight (may extend past it).
    week: dict[int, list[Interval]] = {}
    holiday: list[Interval] | None = None
    value = re.sub(r"\s*-\s*", "-", value.strip())
    # "Mo-Fr 08:00-20:00, Sa 09:00-13:00": a comma after a time that starts a new weekday is
    # a rule separator in practice (the specification calls it an additional rule).
    value = re.sub(r"(\d),\s*(?=(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)\b)", r"\1;", value)
    value = re.sub(r",\s+", ",", value)
    rules = [r.strip() for r in value.replace("||", ";").split(";")]
    for rule in filter(None, rules):
        if rule == "24/7":
            week = {d: [(0, DAY)] for d in range(7)}
            holiday = None  # every day, holidays included
            continue
        parts = rule.split()
        days: list[int] | None = None
        public_holiday = False
        if parts and _is_days(parts[0]):
            days, public_holiday = _days(parts.pop(0))
            if days == [] and not public_holiday:
                continue  # school holidays only
        state = "open"
        if parts and parts[-1] in ("off", "closed", "open"):
            state = parts.pop()
        if len(parts) > 1:
            raise Unsupported(rule)
        times = _times(parts[0]) if parts else [(0, DAY)]
        if days is None:
            if not parts and state == "open":
                raise Unsupported(rule)  # a bare "open" or modifier-only rule
            days = list(range(7))
        for d in days:
            week[d] = [] if state in ("off", "closed") else list(times)
        if public_holiday:
            holiday = [] if state in ("off", "closed") else _merge(list(times))
    if not week:
        raise Unsupported(value)

    intervals: list[Interval] = []
    for d, spans in week.items():
        for start, end in spans:
            a, b = d * DAY + start, d * DAY + end
            if b <= WEEK:
                intervals.append((a, b))
            else:  # Sunday night runs into Monday morning
                intervals.append((a, WEEK))
                intervals.append((0, b - WEEK))
    return _merge(intervals), holiday


def _merge(intervals: list[Interval]) -> list[Interval]:
    merged: list[Interval] = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def multirange(intervals: list[Interval]) -> str:
    """PostgreSQL int4multirange literal: {[0,600),[720,1200)}."""
    return "{" + ",".join(f"[{a},{b})" for a, b in intervals) + "}"


def is_open(intervals: list[Interval], minute_of_week: int) -> bool:
    return any(a <= minute_of_week < b for a, b in intervals)
