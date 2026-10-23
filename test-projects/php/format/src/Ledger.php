<?php

declare(strict_types=1);

namespace Ledger;

final class Ledger
{
    public function balance(int $opening, int $change): int
    {
        return $opening + $change;
    }

    public function doubled( int $amount ) : int { return $amount*2; }
}
