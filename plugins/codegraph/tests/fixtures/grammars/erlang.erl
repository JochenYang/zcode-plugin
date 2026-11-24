-module(greeter).
-export([greet/1, main/0]).

greet(Name) ->
    "Hello, " ++ Name ++ "!".

main() ->
    Greeting = greet("world"),
    io:format("~s~n", [Greeting]).
