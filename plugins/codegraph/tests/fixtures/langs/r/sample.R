library(stats)

#' Adds two numbers.
#'
#' @param x A numeric vector.
#' @param y A numeric vector.
#' @export
add <- function(x, y) {
  x + y
}

#' Builds a counter closure.
make_counter <- function(start = 0) {
  count <- start
  function(by = 1) {
    count <<- count + by
    count
  }
}

MAX_RETRIES <- 3

retry <- function(f, times = MAX_RETRIES) {
  for (i in seq_len(times)) {
    result <- tryCatch(f(), error = function(e) NULL)
  }
  result
}

load_data <- function(path) {
  utils::read.csv(path)
}
