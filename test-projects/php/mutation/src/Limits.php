<?php

declare(strict_types=1);

namespace Ledger;

final class Limits
{
    public function over(int $level, int $limit): bool
    {
        return $level > $limit;
    }
}
