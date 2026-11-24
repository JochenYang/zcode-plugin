package com.example.shop;

import java.util.ArrayList;
import java.util.List;
import static java.util.Objects.requireNonNull;

/** Money amount in cents plus a currency code. */
public final class Money implements Priced {
    private static final int CENTS_PER_UNIT = 100;
    private final long cents;
    private final String currency;

    public Money(long cents, String currency) {
        this.cents = cents;
        this.currency = requireNonNull(currency);
    }

    /** Builds a Money from a whole-unit amount. */
    public static Money of(double amount, String currency) {
        return new Money(Math.round(amount * CENTS_PER_UNIT), currency);
    }

    public Money price() {
        return this;
    }

    public String describe() {
        List<String> parts = new ArrayList<>();
        parts.add(currency);
        parts.add(Long.toString(cents));
        return String.join(" ", parts);
    }
}

interface Priced {
    Money price();
}
