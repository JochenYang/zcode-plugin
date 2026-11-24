package com.example.extra

import java.util.Locale as JavaLocale
import kotlin.collections.*
import kotlin.math.abs

typealias Price = Pair<Int, String>

interface Priced {
    fun price(): Double
}

enum class Region(val label: String) {
    US("United States"),
    EU("European Union");

    fun isUs(): Boolean = this == US
}

sealed class Shape {
    companion object {
        const val MAX_SIDES = 8
        fun of(sides: Int): Shape? = null
    }

    constructor() {
        println("shape")
    }

    constructor(tag: String) : this()
}

class Rect(val w: Int, val h: Int) : Priced {
    var name: String = "rect"
        get() = field.uppercase()

    init {
        println(name)
    }

    override fun price(): Double = area()
    fun area(): Int = w * h
    fun <T : Any> list(vararg items: T): List<T> = items.toList()
}

fun Shape?.describe(): String = this?.let { "shape" } ?: "none"

fun main() {
    val r = Rect(2, 3)
    val sides = Shape.MAX_SIDES
    val p: Price = 1 to "usd"
    val all = listOf(Region.US, Region.EU)
    val upper: (String) -> String = String::uppercase
    val locale = JavaLocale.US
    System.out.println(r.area() + abs(-sides) + upper("x") + locale + all.size + p.first + r.name + Shape.of(3))
    when (r) {
        is Rect -> println("rect")
        else -> println("other")
    }
    val (a, b) = p
}
