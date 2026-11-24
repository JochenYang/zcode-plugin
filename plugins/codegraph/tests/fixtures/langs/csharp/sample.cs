using System;
using System.Collections.Generic;
using System.Globalization;

namespace Shop
{
    /// <summary>Fixed-precision money in minor units.</summary>
    public sealed class Money
    {
        public const int CentsPerUnit = 100;
        private readonly string currency;
        public long Cents { get; private set; }

        public Money(long cents, string currency)
        {
            Cents = cents;
            this.currency = currency;
        }

        /// <summary>Builds a Money from a whole-unit amount.</summary>
        public static Money FromUnits(double amount, string currency)
        {
            return new Money((long)Math.Round(amount * CentsPerUnit), currency);
        }

        public string Describe(CultureInfo culture)
        {
            var parts = new List<string> { culture.Name, currency };
            return string.Join(" ", parts) + " " + Cents / CentsPerUnit;
        }
    }

    public record LineItem(Money Price, int Quantity);

    public interface IPriced
    {
        Money Price();
    }
    public enum Region { Us, Eu }
}
