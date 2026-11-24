import { promptAction } from '@kit.ArkUI';
import { CartItem } from '../model/CartItem';

/** Formats a price in cents. */
export function formatPrice(cents: number, currency: string = 'CNY'): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

export class Cart {
  items: CartItem[] = [];

  add(item: CartItem): number {
    this.items.push(item);
    return this.items.length;
  }
}

const TAX_RATE: number = 0.08;

/** Shopping cart page. */
@Entry
@Component
struct CartPage {
  @State total: number = 0;
  private cart: Cart = new Cart();

  /** Builds the page. */
  build() {
    Column() {
      Text(formatPrice(this.total))
        .fontSize(16)
      Button('Add').onClick(() => this.addOne())
    }
  }

  addOne(): void {
    this.total = this.cart.add(new CartItem(1));
  }
}
