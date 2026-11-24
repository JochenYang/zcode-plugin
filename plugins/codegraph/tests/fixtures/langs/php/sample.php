<?php

namespace App\Billing;

use App\Models\Invoice;
use App\Support\Money as Cash;
use function array_sum;
const VERSION = '1.0';

/** Computes the grand total of an invoice. */
function invoice_total(Invoice $invoice): float
{
    return array_sum(array_map(fn ($line) => $line->amount(), $invoice->lines()));
}

final class Calculator
{
    public const TAX_RATE = 0.2;

    private array $lines = [];

    /** Adds one line. */
    public function add(object $line): void
    {
        $this->lines[] = $line;
    }

    public function total(): float
    {
        $sum = array_sum(array_map(fn ($l) => $l->amount(), $this->lines));
        return self::round($sum * (1 + self::TAX_RATE));
    }

    public static function round(float $value): float
    {
        return round($value, 2);
    }
}

echo Cash::format((new Calculator())->total());
