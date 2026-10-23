/**
 * A JSON encoder for Talos's Lua scripts, which run with nothing but the component's tree. A
 * table with a first element, or no elements, is an array; any other table is an object.
 */
export const LUA_JSON = String.raw`local ESCAPES = { ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }

local function quote(text)
  local escaped = text:gsub('[%c"\\]', function(c)
    return ESCAPES[c] or ("\\u%04x"):format(c:byte())
  end)
  return '"' .. escaped .. '"'
end

local function encode(value)
  local kind = type(value)
  if kind == "string" then
    return quote(value)
  elseif kind ~= "table" then
    return tostring(value)
  end
  local parts = {}
  if value[1] ~= nil or next(value) == nil then
    for _, item in ipairs(value) do
      parts[#parts + 1] = encode(item)
    end
    return "[" .. table.concat(parts, ",") .. "]"
  end
  local keys = {}
  for key in pairs(value) do
    keys[#keys + 1] = key
  end
  table.sort(keys)
  for _, key in ipairs(keys) do
    parts[#parts + 1] = quote(key) .. ":" .. encode(value[key])
  end
  return "{" .. table.concat(parts, ",") .. "}"
end
`;
