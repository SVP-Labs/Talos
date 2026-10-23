<?php

declare(strict_types=1);

namespace Ledger\Domain;

use Ledger\Infrastructure\Database;

final class Account
{
    public function __construct(private readonly Database $database) {}

    public function balance(): int
    {
        return $this->database->sum();
    }
}
