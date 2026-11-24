import { useState, Component } from 'react';
import type { Cart } from './cart';

interface Props {
  cart: Cart;
}

/** Shows the cart total with an expand toggle. */
export function CartTotal({ cart }: Props) {
  const [open, setOpen] = useState(false);
  const total = cart.total();
  return (
    <button onClick={() => setOpen(!open)} className="total">
      {open ? total : `${total} items`}
    </button>
  );
}

export class CartList extends Component<Props> {
  render() {
    return <ul>{this.props.cart.items.map((i) => <li key={i.id}>{i.name}</li>)}</ul>;
  }
}

const PriceTag = ({ cents }: { cents: number }) => <span>{formatPrice(cents)}</span>;

export default CartList;
