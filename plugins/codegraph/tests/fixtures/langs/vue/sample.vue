<script>
/** Options that cannot be declared in <script setup>. */
const OPTIONS = { name: 'CartTotal', inheritAttrs: false };
export default OPTIONS;
</script>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Cart } from './cart';

interface Props {
  cart: Cart;
}

class Line {
  items: Cart[] = [];
  add(item: Cart): number {
    this.items.push(item);
    return this.items.length;
  }
}

const props = defineProps<Props>();
const open = ref(false);

/** Cart total in cents, formatted for display. */
const total = computed(() => props.cart.total());

function toggle(): void {
  open.value = !open.value;
}
</script>

<template>
  <button class="total" :class="{ open }" @click="toggle">
    {{ open ? total : `${total} items` }}
  </button>
</template>
