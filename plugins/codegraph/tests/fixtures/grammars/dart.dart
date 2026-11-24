class Greeter {
  final String name;

  Greeter(this.name);

  String greet() => 'Hello, $name!';
}

void main() {
  final greeter = Greeter('world');
  print(greeter.greet());
}
