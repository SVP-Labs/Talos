<?php

final class Thing
{
    /** @codeCoverageIgnore */
    public function size(mixed $value): int
    {
        // @phpstan-ignore-next-line
        return count($value);
    }
}
