"""The high layer."""

import pytest

from layered import ring_a
from tests import helpers

CEILING = helpers.SAMPLE + len(pytest.__name__) + ring_a.A
