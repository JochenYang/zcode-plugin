package com.example.shop

import java.util.Locale
import kotlin.math.roundToInt

/** Fixed-precision money in minor units. */
data class Money(val cents: Long, val currency: String = "USD") {

    /** Whole units, rounded to two decimals. */
    fun units(): Double = (cents / 100.0).roundToInt() / 100.0

    operator fun plus(other: Money): Money {
        require(currency == other.currency) { "currency mismatch" }
        return Money(cents + other.cents, currency)
    }
}

object Pricer {
    const val TAX_RATE = 0.19
    private val cache = mutableMapOf<String, Money>()

    fun gross(net: Money): Money = Money((net.cents * (1 + TAX_RATE)).roundToInt(), net.currency)
}

fun formatAmounts(items: List<Money>, locale: Locale = Locale.US): String =
    items.joinToString(separator = ", ") { m -> String.format(locale, "%.2f %s", m.units(), m.currency) }
