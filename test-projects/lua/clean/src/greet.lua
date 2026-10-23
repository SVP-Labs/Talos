--- Greetings for people.
local greet = {}

--- Builds a greeting for a name.
---@param name string the person to greet
---@return string greeting the greeting
function greet.hello(name)
    return "Hello, " .. name .. "!"
end

--- Says whether a greeting is shouted.
---@param text string the greeting
---@return boolean shouted whether no letter is lower case
function greet.shouted(text)
    return text == text:upper()
end

return greet
