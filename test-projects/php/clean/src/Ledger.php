<?php

declare(strict_types=1);

namespace Ledger;

use InvalidArgumentException;

final class Ledger
{
    /** @var list<int> */
    private array $entries = [];

    public function record(int $amount): void
    {
        if ($amount === 0) {
            throw new InvalidArgumentException('An entry needs an amount.');
        }

        $this->entries[] = $amount;
    }

    public function balance(): int
    {
        return array_sum($this->entries);
    }

    public function count(): int
    {
        return count($this->entries);
    }
}
