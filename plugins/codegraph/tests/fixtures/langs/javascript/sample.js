import path from 'node:path';
import { formatMoney } from './money.js';

/** Formats a price with currency. */
export function formatPrice(cents, currency = 'USD') {
  const amount = cents / 100;
  return formatMoney(amount, currency);
}

export class Cart {
  items = [];

  /** Adds an item and returns the new size. */
  add(item) {
    this.items.push(item);
    return this.items.length;
  }

  total() {
    return this.items.reduce((sum, i) => sum + i.price, 0);
  }
}

const TAX_RATE = 0.08;
const calcTax = (cents) => Math.round(cents * TAX_RATE);

const PriceTag = ({ cents }) => <span className="price">{formatPrice(cents)}</span>;

export default function checkout(cart) {
  return new Cart().add(path.join('carts', String(cart.id)));
}
