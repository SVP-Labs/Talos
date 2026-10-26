import { LUA_JSON } from './json.js';

/** The formatter's module name; luacheck requires it by name, so it must be unusual. */
export const FORMATTER_MODULE = 'talos_luacheck_json';

/**
 * A luacheck formatter: every file luacheck checked, with its warnings in luacheck's own words
 * and its fatal error if it had one, as one JSON object. A file luacheck skipped is absent.
 */
const FORMATTER_BODY = String.raw`local format = require("luacheck.format")

return function(report, file_names)
  local files = {}
  for index, file_report in ipairs(report) do
    local events = {}
    for _, event in ipairs(file_report) do
      events[#events + 1] = {
        code = event.code,
        line = event.line,
        column = event.column,
        endColumn = event.end_column or event.column,
        message = format.get_message(event),
      }
    end
    files[#files + 1] = {
      file = file_names[index],
      fatal = file_report.fatal or "",
      error = file_report.msg or "",
      events = events,
    }
  end
  return encode({ files = files })
end
`;

export const LUACHECK_FORMATTER = {
  name: `${FORMATTER_MODULE}.lua`,
  source: `-- Talos: luacheck's report as JSON.\n${LUA_JSON}\n${FORMATTER_BODY}`,
};

/**
 * Loads `.luacheckrc` the way luacheck does, from the current directory (so it requires the
 * project's file relative to it), validates it, and prints the options that can weaken a check,
 * at the top level and for each `files` pattern. Values are strings, numbers, booleans or lists
 * of strings; a std given as a table prints as "(table)".
 */
const CONFIG_BODY = String.raw`local config = require("luacheck.config")

local OPTIONS = {
  "std", "compat", "global", "unused", "redefined", "unused_args", "unused_secondaries", "self",
  "allow_defined", "allow_defined_top", "module", "max_line_length", "max_code_line_length",
  "max_string_line_length", "max_comment_line_length", "max_cyclomatic_complexity",
  "ignore", "only", "exclude_files", "include_files",
}

local function value_of(name, value)
  if type(value) ~= "table" then
    return value
  elseif name == "std" then
    return "(table)"
  end
  local items = {}
  for _, item in ipairs(value) do
    items[#items + 1] = tostring(item)
  end
  return items
end

local function pick(options)
  local picked = {}
  for _, name in ipairs(OPTIONS) do
    if options[name] ~= nil then
      picked[#picked + 1] = { name = name, value = value_of(name, options[name]) }
    end
  end
  return picked
end

local conf, err = config.load_config(".luacheckrc", false)
local stacked
if conf then
  stacked, err = config.stack_configs({ conf })
end
if not stacked then
  io.write(encode({ error = tostring(err) }), "\n")
  return
end
local files = {}
for glob, options in pairs(conf.options.files or {}) do
  if type(glob) == "string" then
    files[#files + 1] = { glob = glob, options = pick(options) }
  end
end
table.sort(files, function(a, b) return a.glob < b.glob end)
io.write(encode({ error = "", top = pick(conf.options), files = files }), "\n")
`;

export const LUACHECK_CONFIG_SCRIPT = {
  name: 'talos_luacheck_config.lua',
  source: `-- Talos: the options luacheck loads.\n${LUA_JSON}\n${CONFIG_BODY}`,
};
