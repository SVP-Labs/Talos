from tally.count import most_common, words


def test_words_are_lower_case() -> None:
    assert words("The the CAT") == ["the", "the", "cat"]


def test_most_common_counts() -> None:
    assert most_common("a b a", 1) == [("a", 2)]


def test_most_common_needs_a_limit() -> None:
    assert most_common("a b a", 0) == []
