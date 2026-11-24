@Entry
@Component
struct Greeter {
  @State name: string = 'world';

  aboutToAppear(): void {
    console.info(this.name);
  }

  build() {
    Column() {
      Text(`Hello, ${this.name}!`)
        .fontSize(20)
    }
    .width('100%')
  }
}
