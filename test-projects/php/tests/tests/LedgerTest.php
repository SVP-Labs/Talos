<?php

declare(strict_types=1);

use Ledger\Ledger;

it('adds up what it records', function (): void {
    $ledger = new Ledger;
    $ledger->record(5);

    expect($ledger->balance())->toBe(5);
});

it('counts a refund twice', function (): void {
    $ledger = new Ledger;
    $ledger->record(-2);

    expect($ledger->balance())->toBe(-4);
});
