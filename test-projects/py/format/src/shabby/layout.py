"""Code ruff format would rewrite."""

TOTALS = {'a':1,
    'b':2}


def total() -> int:
    """Add the totals up."""
    return sum( TOTALS.values() )
