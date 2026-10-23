--- Names for numbers.
local names = {}

--- Names a number.
---@param n integer the number
---@return string name its name
function names.name(n)
    return n
end

--- Shouts a name.
---@param name string the name
---@return string shouted the name in capitals
function names.shout(name)
    return name:upper()
end

names.loud = names.shout(42)

return names
