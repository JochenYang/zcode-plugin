class Counter {
  constructor(start = 0) {
    this.value = start;
  }

  increment(by = 1) {
    this.value += by;
    return this.value;
  }
}

const counter = new Counter(10);
console.log(counter.increment(5));
