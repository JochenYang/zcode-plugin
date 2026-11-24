package fixture

class Greeter(name: String) {
  def greet(): String = s"Hello, $name!"
}

object Main {
  def main(args: Array[String]): Unit = {
    val greeter = new Greeter("world")
    println(greeter.greet())
  }
}
