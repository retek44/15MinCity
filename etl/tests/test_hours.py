import pytest

from reach15_etl import hours

MO, TU, SA, SU = 0, 1, 5, 6


def at(day: int, hh: int, mm: int = 0) -> int:
    return day * hours.DAY + hh * 60 + mm


def test_24_7_is_the_whole_week():
    assert hours.parse("24/7") == [(0, hours.WEEK)]


def test_weekday_range_and_day_off():
    iv = hours.parse("Mo-Fr 08:00-20:00; Sa 08:00-14:00; Su off")
    assert hours.is_open(iv, at(TU, 8))
    assert not hours.is_open(iv, at(TU, 20))  # end is exclusive
    assert hours.is_open(iv, at(SA, 13, 59))
    assert not hours.is_open(iv, at(SA, 14))
    assert not hours.is_open(iv, at(SU, 12))


def test_split_shifts_and_day_lists():
    iv = hours.parse("Mo,We 09:00-12:00,13:00-17:00")
    assert hours.is_open(iv, at(MO, 9))
    assert not hours.is_open(iv, at(MO, 12, 30))
    assert not hours.is_open(iv, at(TU, 10))
    assert hours.is_open(iv, at(2, 16))


def test_past_midnight_and_sunday_wraps_to_monday():
    iv = hours.parse("Su 22:00-02:00")
    assert hours.is_open(iv, at(SU, 23))
    assert hours.is_open(iv, at(MO, 1, 30))
    assert not hours.is_open(iv, at(MO, 2))


def test_later_rules_replace_earlier_ones_for_their_days():
    iv = hours.parse("Mo-Su 08:00-22:00; Su 10:00-18:00")
    assert hours.is_open(iv, at(SA, 21))
    assert not hours.is_open(iv, at(SU, 9))
    assert hours.is_open(iv, at(SU, 10))


def test_wrapping_weekday_range():
    iv = hours.parse("Sa-Mo 10:00-12:00")
    assert all(hours.is_open(iv, at(d, 11)) for d in (SA, SU, MO))
    assert not hours.is_open(iv, at(TU, 11))


def test_holiday_only_rules_are_skipped():
    assert hours.parse("Mo-Fr 08:00-16:00; PH off") == hours.parse("Mo-Fr 08:00-16:00")


def test_comma_separated_rules_and_loose_spacing():
    iv = hours.parse("Mo-Fr 08:00 - 20:00, Sa 09:00-13:00")
    assert hours.is_open(iv, at(SA, 10))
    assert hours.is_open(iv, at(TU, 19))


def test_always_closed_is_known_not_unknown():
    assert hours.parse("off") == []


@pytest.mark.parametrize(
    "value",
    [
        None,
        "",
        "Jan-Mar Mo-Fr 08:00-16:00",
        "Mo-Fr sunrise-sunset",
        '"by appointment"',
        "Mo-Fr 08:00+",
        "open",
    ],
)
def test_unsupported_values_are_unknown(value):
    assert hours.parse(value) is None


def test_multirange_literal():
    assert hours.multirange([(0, 600), (720, 1200)]) == "{[0,600),[720,1200)}"
    assert hours.multirange([]) == "{}"
