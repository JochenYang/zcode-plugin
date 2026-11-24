using System.Collections.Generic;
using System.Linq;
using static System.Math;
using IO = System.IO;
using System.Text;

namespace Extra
{
    internal struct Point
    {
        public int X;
        public int Y;

        public Point(int x, int y)
        {
            X = x;
            Y = y;
        }

        public readonly double Norm() => Math.Sqrt(X * X + Y * Y);
    }

    public delegate bool Predicate<in T>(T value);

    public class Cart : ICloneable
    {
        private static readonly IReadOnlyList<string> Empty = Array.Empty<string>();
        public event EventHandler? Saved;

        public Cart() : this(0) { }

        public Cart(int seed)
        {
            Seed = seed;
        }

        public int Seed { get; set; }
        public List<int>? Items { get; set; }

        public object Clone()
        {
            var copy = new Cart { Seed = Seed, Items = Items?.ToList() };
            var names = from n in new[] { "a", "b" } where n.Length > 0 select n.ToUpperInvariant();
            foreach (var (index, name) in names.Select((n, i) => (i, n)))
            {
                if (index > 0 && name is string) continue;
            }
            Saved?.Invoke(this, EventArgs.Empty);
            return copy;
        }

        static Cart() { Empty = new List<string>(); }

        public override string ToString() => $"cart {Seed}";
    }

    class Program
    {
        static void Main(string[] args)
        {
            var p = new Point(3, 4);
            var carts = new List<Cart> { new Cart(1) };
            int total = carts.Sum(c => c.Seed) + (int)Max(1, p.X);
            Dictionary<string, int> map = new() { ["a"] = 1 };
            var typed = (IEnumerable<Cart>)carts;
            System.Console.WriteLine(total + typed.Count() + string.Join(",", map.Keys));
        }
    }
}
