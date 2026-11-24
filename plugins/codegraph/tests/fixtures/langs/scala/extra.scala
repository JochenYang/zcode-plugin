package com.example.extra

import java.util.{Locale, Random =>Rnd}
import scala.collection._
import scala.concurrent.Future

/** Something with a price. */
trait Priced {
  def price: Double
  protected def tag: String = "priced"
}

/** Optional discount. */
type Discount = Option[Double]

abstract class Base {
  var count: Int = 0
  def bump(delta: Int): Unit = count += delta
  private def hidden(): Int = 1
}

class Cart extends Priced {
  private val items = mutable.ListBuffer.empty[String]
  override def price: Double = items.size
}

object Cart {
  def apply(first: String): Cart = {
    val c = new Cart()
    c.items += first
    c
  }
}
