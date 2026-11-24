-- Types and exports for a small vector module.
local Types = require("./types")

export type Vec2 = { x: number, y: number }

type Kind = "add" | "sub"

local Vector = {}
Vector.__index = Vector

function Vector.new(x: number, y: number): Vec2
	return { x = x, y = y }
end

function Vector.add(a: Vec2, b: Vec2): Vec2
	return { x = a.x + b.x, y = a.y + b.y }
end

function Vector:length(): number
	return math.sqrt(self.x ^ 2 + self.y ^ 2)
end

function sum(vs: { Vec2 }): Vec2
	local acc = Vector.new(0, 0)
	for _, v in vs do
		acc = Vector.add(acc, v)
	end
	return acc
end

return Vector
