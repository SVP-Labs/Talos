"""Code too tangled to keep."""


def classify(a: int, b: int, c: int, d: int) -> str:
    """Classify four numbers."""
    result = "none"
    for value in (a, b, c, d):
        if value > 0:
            for step in range(value):
                if step % 2 == 0:
                    while step > 0:
                        if step > a:
                            result = "deep"
                        elif step > b or (step < c and step != d):
                            result = "wide"
                        elif step == c and d > a:
                            result = "odd"
                        step -= 1
                elif step % 3 == 0:
                    result = "three"
                elif step % 5 == 0:
                    result = "five"
                elif step % 7 == 0:
                    result = "seven"
                elif step % 11 == 0:
                    result = "eleven"
        elif value < -10:
            result = "low"
        else:
            result = "zero" if value == 0 else "negative"
    return result
