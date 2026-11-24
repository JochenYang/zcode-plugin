package main

import "fmt"

type Greeter struct {
	Name string
}

func (g Greeter) Greet() string {
	return "Hello, " + g.Name + "!"
}

func main() {
	greeter := Greeter{Name: "world"}
	fmt.Println(greeter.Greet())
}
