from lenient.limits import over


def test_far_over() -> None:
    assert over(10, 1)
