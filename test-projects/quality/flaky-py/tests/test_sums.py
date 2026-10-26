from pathlib import Path

from flaky.sums import add

MARKER = Path(__file__).with_name(".ran-once")


def test_add() -> None:
    assert add(2, 2) == 4


def test_add_first_time_fails() -> None:
    ran_before = MARKER.exists()
    MARKER.touch()
    assert ran_before, "the first run of this test always fails"
    assert add(1, 1) == 2
