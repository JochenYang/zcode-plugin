local json = require("json")

local M = {}
local MAX_ITEMS = 10

--- Encodes a value, falling back to an empty object.
function M.encode(value)
  return json.encode(value or {})
end

function M.decode(text)
  return json.decode(text)
end

local Counter = {}
Counter.__index = Counter

function Counter.new(start)
  return setmetatable({ count = start or 0 }, Counter)
end

function Counter:increment(by)
  self.count = self.count + (by or 1)
  return self.count
end

function M.report(counter)
  return string.format("count=%d", counter:increment())
end

return M
