local Greeter = {}
Greeter.__index = Greeter

function Greeter.new(name: string)
    return setmetatable({ name = name }, Greeter)
end

function Greeter:greet(): string
    return `Hello, {self.name}!`
end

local greeter = Greeter.new("world")
print(greeter:greet())
