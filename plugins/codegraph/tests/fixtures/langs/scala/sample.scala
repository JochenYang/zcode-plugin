package com.example.shop

import scala.collection.mutable
import java.util.Locale

/** Fixed-precision money in minor units. */
case class Money(cents: Long, currency: String = "USD") {

  /** Whole units, rounded to two decimals. */
  def units: Double = cents / 100.0

  def add(other: Money): Money = {
    require(currency == other.currency, "currency mismatch")
    Money(cents + other.cents, currency)
  }
}

object Pricer {
  val TaxRate = 0.19
  private val cache = mutable.Map.empty[String, Money]

  def gross(net: Money): Money = Money((net.cents * (1 + TaxRate)).toLong, net.currency)
}

def formatAmounts(items: List[Money], locale: Locale = Locale.US): String =
  items.map(m => String.format(locale, "%.2f %s", m.units, m.currency)).mkString(", ")
