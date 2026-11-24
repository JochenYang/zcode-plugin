using System;

namespace Fixture
{
    public class Greeter
    {
        private readonly string name;

        public Greeter(string name)
        {
            this.name = name;
        }

        public string Greet()
        {
            return "Hello, " + name + "!";
        }

        public static void Main(string[] args)
        {
            Greeter greeter = new Greeter("world");
            Console.WriteLine(greeter.Greet());
        }
    }
}
