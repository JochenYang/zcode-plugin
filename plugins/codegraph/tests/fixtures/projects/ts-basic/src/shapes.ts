import { helper } from './util';
import { helper as twice } from './util';

export class Shape {
  scale = 1;

  area(): number {
    return this.scale;
  }

  scaled(): number {
    return this.area() * twice(this.scale);
  }

  static create(): Shape {
    return new Shape();
  }

  static defaultScale(): number {
    return Shape.create().area();
  }
}
