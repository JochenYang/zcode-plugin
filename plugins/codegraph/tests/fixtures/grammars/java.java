package fixture;

public class Greeter {
    private final String name;

    public Greeter(String name) {
        this.name = name;
    }

    public String greet() {
        return "Hello, " + name + "!";
    }

    public static void main(String[] args) {
        Greeter greeter = new Greeter("world");
        System.out.println(greeter.greet());
    }
}
