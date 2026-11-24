<script context="module">
  /** Sums item prices in cents. */
  export function sumItems(items) {
    return items.reduce((sum, i) => sum + i.price, 0);
  }
</script>

<script lang="ts">
  import { fade } from 'svelte/transition';
  import type { CartItem } from './cart';

  interface Props {
    items: CartItem[];
  }

  let { items }: Props = $props();
  let open = $state(false);
  const TAX_RATE = 0.08;

  class Cart {
    items: CartItem[] = [];

    add(item: CartItem): number {
      this.items.push(item);
      return this.items.length;
    }
  }

  const cart = new Cart();

  /** Tax for the whole cart. */
  function tax(): number {
    return Math.round(sumItems(cart.items) * TAX_RATE);
  }
</script>

<button class="total" transition:fade={{ duration: 150 }} on:click={() => (open = !open)}>
  {open ? tax() : `${items.length} items`}
</button>
