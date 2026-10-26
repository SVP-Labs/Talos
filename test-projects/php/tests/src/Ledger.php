<?php

declare(strict_types=1);

namespace Ledger;

final class Ledger
{
    /** @var list<int> */
    private array $entries = [];

    public function record(int $amount): void
    {
        $this->entries[] = $amount;
    }

    public function balance(): int
    {
        return array_sum($this->entries);
    }

    public function clear(): void
    {
        $this->entries = [];
    }
}
