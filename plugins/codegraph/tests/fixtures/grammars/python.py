"""Minimal Python fixture."""


class Greeter:
    def __init__(self, name: str) -> None:
        self.name = name

    def greet(self) -> str:
        return f"Hello, {self.name}!"


def main() -> None:
    greeter = Greeter("world")
    print(greeter.greet())


main()
