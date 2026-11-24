local Greeter = {}
Greeter.__index = Greeter

function Greeter.new(name)
    return setmetatable({ name = name }, Greeter)
end

function Greeter:greet()
    return "Hello, " .. self.name .. "!"
end

local greeter = Greeter.new("world")
print(greeter:greet())
