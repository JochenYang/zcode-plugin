package fixture

class Greeter(private val name: String) {
    fun greet(): String = "Hello, $name!"
}

fun main() {
    val greeter = Greeter("world")
    println(greeter.greet())
}
