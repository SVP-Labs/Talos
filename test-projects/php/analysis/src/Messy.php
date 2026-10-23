<?php

declare(strict_types=1);

namespace Ledger;

final class Messy
{
    public function many(int $first, int $second, int $third, int $fourth, int $fifth): int
    {
        return $first + $second + $third + $fourth + $fifth;
    }

    public function branchy(int $value): string
    {
        if ($value === 1) {
            return 'one';
        }
        if ($value === 2) {
            return 'two';
        }
        if ($value === 3) {
            return 'three';
        }
        if ($value === 4) {
            return 'four';
        }
        if ($value === 5) {
            return 'five';
        }
        if ($value === 6) {
            return 'six';
        }
        if ($value === 7) {
            return 'seven';
        }
        if ($value === 8) {
            return 'eight';
        }
        if ($value === 9) {
            return 'nine';
        }
        if ($value === 10) {
            return 'ten';
        }
        if ($value === 11) {
            return 'eleven';
        }
        if ($value === 12) {
            return 'twelve';
        }
        if ($value === 13) {
            return 'thirteen';
        }

        return 'many';
    }

    /** @param list<list<int>> $rows */
    public function nested(array $rows): int
    {
        $total = 0;
        foreach ($rows as $row) {
            if (count($row) > 1) {
                foreach ($row as $cell) {
                    if ($cell > 10) {
                        for ($step = 0; $step < $cell; $step++) {
                            $total += $step > 5 && $step < 50 ? $step : 1;
                        }
                    }
                }
            }
        }

        return $total;
    }

    public function untyped($value): int
    {
        return $value == 1 ? 1 : 0;
    }
}
