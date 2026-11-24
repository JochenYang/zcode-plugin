<template>
  <p>{{ greet }}</p>
</template>

<script setup>
import { computed } from 'vue';

const name = 'world';
const greet = computed(() => `Hello, ${name}!`);
</script>
