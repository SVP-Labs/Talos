"""Word counting."""

from collections import Counter


def words(text: str) -> list[str]:
    """Split text into lower-case words.

    Args:
        text: The text to split.

    Returns:
        The words, in order.
    """
    return [word.lower() for word in text.split()]


def most_common(text: str, limit: int) -> list[tuple[str, int]]:
    """Return the most common words with their counts.

    Args:
        text: The text to count.
        limit: How many words to return.

    Returns:
        Up to ``limit`` words, the most frequent first.
    """
    if limit < 1:
        return []
    return Counter(words(text)).most_common(limit)
