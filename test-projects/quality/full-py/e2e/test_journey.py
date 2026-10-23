from journey.sums import add


def test_journey() -> None:
    assert add(2, 2) == 5, "the end-to-end journey is broken"
