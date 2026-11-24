<?php

namespace Fixture;

final class Greeter
{
    private $name;

    public function __construct($name)
    {
        $this->name = $name;
    }

    public function greet()
    {
        return 'Hello, ' . $this->name . '!';
    }
}

$greeter = new Greeter('world');
echo $greeter->greet(), PHP_EOL;
