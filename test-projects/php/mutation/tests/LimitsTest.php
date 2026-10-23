<?php

declare(strict_types=1);

use Ledger\Limits;

it('says a level well past the limit is over it', function (): void {
    expect((new Limits)->over(10, 5))->toBeTrue();
});

it('says a level well under the limit is not over it', function (): void {
    expect((new Limits)->over(1, 5))->toBeFalse();
});
