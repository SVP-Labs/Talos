"""Conversions that lose their types."""

import json
from typing import Any


def parse(text: str) -> Any:
    """Parse JSON without saying what comes out."""
    return json.loads(text)


def width(text: str) -> int:
    """Return how wide some text is."""
    return text
