<?php

declare(strict_types=1);

use Ledger\Ledger;

it('starts empty', function (): void {
    $ledger = new Ledger;

    expect($ledger->balance())->toBe(0);
    expect($ledger->count())->toBe(0);
});

it('adds up what it records', function (): void {
    $ledger = new Ledger;
    $ledger->record(5);
    $ledger->record(-2);

    expect($ledger->balance())->toBe(3);
    expect($ledger->count())->toBe(2);
});

it('refuses an entry of nothing', function (): void {
    $ledger = new Ledger;

    expect(fn () => $ledger->record(0))->toThrow(InvalidArgumentException::class);
});
