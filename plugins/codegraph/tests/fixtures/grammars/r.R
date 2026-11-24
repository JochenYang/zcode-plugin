greet <- function(x) {
  paste0("Hello, ", x$name, "!")
}

new_greeter <- function(name) {
  structure(list(name = name), class = "greeter")
}

greeter <- new_greeter("world")
print(greet(greeter))
