let
  greet = name: "Hello, ${name}!";
in
rec {
  greeting = greet "world";
  greetings = map greet [ "a" "b" ];
}
