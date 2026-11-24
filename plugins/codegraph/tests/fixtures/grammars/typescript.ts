interface Greeter {
  name: string;
  greet(): string;
}

class Hello implements Greeter {
  constructor(public name: string) {}

  greet(): string {
    return `Hello, ${this.name}!`;
  }
}

const hello = new Hello("world");
console.log(hello.greet());
