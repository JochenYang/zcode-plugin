import Foundation

struct Greeter {
    let name: String

    func greet() -> String {
        return "Hello, \(name)!"
    }
}

let greeter = Greeter(name: "world")
print(greeter.greet())
