"""Code nothing calls."""


def used() -> int:
    """Return a number someone needs."""
    return 1


def forgotten() -> int:
    """Return a number nobody asks for."""
    return used() + 1


def on_event() -> int:
    """Run when a framework calls it by name."""
    return used()
