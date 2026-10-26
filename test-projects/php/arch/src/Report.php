<?php

declare(strict_types=1);

namespace Ledger;

use PhpParser\ParserFactory;
use Tests\Support\Fixture;

final class Report
{
    public function render(): string
    {
        $parser = (new ParserFactory)->createForNewestSupportedVersion();

        return Fixture::title().get_class($parser);
    }
}
