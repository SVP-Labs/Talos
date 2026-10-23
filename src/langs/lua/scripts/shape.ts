import { LUA_JSON } from './json.js';

/**
 * Measures every function of the files it is given with luacheck's own parser: its span, its
 * parameters (an implicit `self` and `...` left out), its lines of code, its deepest nesting
 * of control statements, and its cognitive complexity. Each function is measured alone, so a
 * nested function counts toward itself, not the function around it. The main chunk is measured
 * for nesting only, and each file gets its line count and the numbers of its lines of code.
 * Prints one JSON object; a file luacheck can't parse is marked, not measured.
 */
const BODY = String.raw`local decoder = require("luacheck.decoder")
local parser = require("luacheck.parser")

local CONTROL = { If = true, While = true, Repeat = true, Fornum = true, Forin = true }
local ASSIGNING = { Set = true, Local = true, Localrec = true }

local function line_of(offsets, offset)
  local low, high = 1, #offsets
  while low < high do
    local middle = (low + high + 1) // 2
    if offsets[middle] <= offset then
      low = middle
    else
      high = middle - 1
    end
  end
  return low
end

local function name_of(node)
  if node.tag == "Id" then
    return node[1]
  elseif node.tag == "Index" and node[2].tag == "String" then
    local base = name_of(node[1])
    return base and (base .. "." .. node[2][1])
  end
end

local Walk = {}
Walk.__index = Walk

function Walk:list(nodes, depth)
  for _, node in ipairs(nodes) do
    if type(node) == "table" then
      self:node(node, depth)
    end
  end
end

function Walk:logical(node, depth, outer)
  local operator = node[1]
  if operator ~= "and" and operator ~= "or" then
    self:list({ node[2], node[3] }, depth)
    return
  end
  if operator ~= outer then
    self.cognitive = self.cognitive + 1
  end
  for index = 2, 3 do
    local operand = node[index]
    if operand.tag == "Op" then
      self:logical(operand, depth, operator)
    else
      self:node(operand, depth)
    end
  end
end

function Walk:control(node, depth)
  local nesting = depth + 1
  self.cognitive = self.cognitive + nesting
  if node.tag == "If" then
    self.cognitive = self.cognitive + (#node // 2 - 1) + #node % 2
  end
  if nesting > self.deepest.depth then
    self.deepest = { depth = nesting, line = node.line, endLine = line_of(self.offsets, node.end_offset) }
  end
  for _, child in ipairs(node) do
    if type(child) == "table" then
      if child.tag == nil then
        self:list(child, nesting)
      else
        self:node(child, depth)
      end
    end
  end
end

function Walk:node(node, depth)
  local tag = node.tag
  if tag == "Function" then
    self.queue[#self.queue + 1] = node
  elseif CONTROL[tag] then
    self:control(node, depth)
  elseif tag == "Op" then
    self:logical(node, depth)
  else
    if tag == "Goto" then
      self.cognitive = self.cognitive + 1
    elseif ASSIGNING[tag] then
      for index, value in ipairs(node[2] or {}) do
        if value.tag == "Function" and node[1][index] then
          self.names[value] = name_of(node[1][index])
        end
      end
    end
    self:list(node, depth)
  end
end

local function count_lines(code_lines, first, last)
  local count = 0
  for line = first, last do
    count = count + (code_lines[line] and 1 or 0)
  end
  return count
end

local function line_numbers(code_lines, last)
  local numbers = {}
  for line = 1, last do
    if code_lines[line] then
      numbers[#numbers + 1] = line
    end
  end
  return numbers
end

local function walk(body, file)
  local state = setmetatable({ cognitive = 0, deepest = { depth = 0 }, queue = file.queue,
    names = file.names, offsets = file.offsets }, Walk)
  state:list(body, 0)
  return state
end

local function measure(file, node)
  local state = walk(node[2], file)
  local params = 0
  for _, arg in ipairs(node[1]) do
    params = params + ((arg.tag == "Id" and not arg.implicit) and 1 or 0)
  end
  local last = node.end_range.line
  return {
    name = file.names[node] or "",
    line = node.line,
    endLine = last,
    params = params,
    codeLines = count_lines(file.code_lines, node.line, last),
    cognitive = state.cognitive,
    depth = state.deepest.depth,
    deepLine = state.deepest.line or node.line,
    deepEndLine = state.deepest.endLine or last,
  }
end

local function measure_file(path)
  local handle = io.open(path, "rb")
  if not handle then
    return { file = path, error = "unreadable" }
  end
  local bytes = handle:read("a")
  handle:close()
  local offsets = {}
  local ok, ast, _, code_lines = pcall(parser.parse, decoder.decode(bytes), offsets, {})
  if not ok then
    return { file = path, error = "syntax" }
  end
  local file = { queue = {}, names = {}, offsets = offsets, code_lines = code_lines }
  local main = walk(ast, file)
  local functions = {}
  local index = 1
  while file.queue[index] do
    functions[#functions + 1] = measure(file, file.queue[index])
    index = index + 1
  end
  return {
    file = path,
    error = "",
    lines = #offsets,
    code = line_numbers(code_lines, #offsets),
    depth = main.deepest.depth,
    deepLine = main.deepest.line or 1,
    deepEndLine = main.deepest.endLine or 1,
    functions = functions,
  }
end

local files = {}
for index = 1, #arg do
  files[#files + 1] = measure_file(arg[index])
end
io.write(encode({ files = files }), "\n")
`;

export const SHAPE_SCRIPT = {
  name: 'talos_shape.lua',
  source: `-- Talos: measures Lua functions with luacheck's parser.\n${LUA_JSON}\n${BODY}`,
};
