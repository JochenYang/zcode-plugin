package com.example.extra;

import java.util.*;
import static java.lang.Math.max;

/** Optional line item. */
public record LineItem(Money amount, int quantity) implements Priced {
    public static final LineItem EMPTY = new LineItem(null, 0);

    @Override
    public Money price() {
        return amount;
    }
}

/** Supported sales regions. */
enum Region implements Named {
    US("United States"),
    EU("European Union");

    private final String label;

    Region(String label) {
        this.label = label;
    }

    @Override
    public String label() {
        return label;
    }
}

interface Named {
    String label();
}

interface Defaults {
    int SCALE = 2;

    default String name() {
        return "defaults";
    }
}

abstract class Base {
    Base(int seed) {
        this(seed, seed * 2);
    }

    Base(int seed, int span) {
        super();
    }

    abstract java.util.List<String> names();

    static <T> T pick(T[] items, int index) {
        return items[index];
    }
}

class Cart extends Base {
    Cart() {
        super(1);
    }

    void run() {
        Runnable task = () -> System.out.println("go");
        task.run();
        java.util.List<Integer> ids = new java.util.ArrayList<>();
        for (Integer id : ids) {
            if (id > 0) System.out.println(id);
        }
        try {
            ids.get(5);
        } catch (IndexOutOfBoundsException err) {
            throw new IllegalStateException("bad index", err);
        }
        int best = max(1, 2);
        String[] names = ids.stream().map(String::valueOf).toArray(String[]::new);
        java.util.function.Function<Integer, Integer> twice = n -> n * 2;
        System.out.println("best=" + best + twice.apply(best));
    }
}
