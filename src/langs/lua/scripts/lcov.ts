/**
 * Writes LCOV for the listed sources from a luacov stats file, using luacov's own view of which
 * lines can run (with cluacov, from the compiled code). A source no test loaded is reported with
 * every line it can run missed. Stats name files as Lua loaded them (`./src/x.lua`,
 * `src\x.lua`), so names are normalised to the list's form: relative, forward slashes.
 * Arguments: the stats file, the output file, the file listing the sources, one per line.
 */
const BODY = String.raw`local reporter = require("luacov.reporter")
local stats = require("luacov.stats")

local stats_path, out_path, list_path = arg[1], arg[2], arg[3]

local function normalize(name)
  name = name:gsub("\\", "/")
  while name:sub(1, 2) == "./" do
    name = name:sub(3)
  end
  return name
end

local data = {}
for name, hits in pairs(stats.load(stats_path) or {}) do
  local key = normalize(name)
  local known = data[key]
  if known then
    for line, count in pairs(hits) do
      if type(line) == "number" then
        known[line] = (known[line] or 0) + count
      end
    end
  else
    data[key] = hits
  end
end

local files = {}
for line in io.lines(list_path) do
  if line ~= "" then
    files[#files + 1] = line
    data[line] = data[line] or { max = 0, max_hits = 0 }
  end
end

local Lcov = setmetatable({}, reporter.ReporterBase)
Lcov.__index = Lcov

function Lcov:on_new_file(filename)
  self:write("SF:", filename, "\n")
end

function Lcov:on_file_error(filename, kind, message)
  io.stderr:write(("could not %s %s: %s\n"):format(kind, filename, message))
  os.exit(2)
end

function Lcov:on_mis_line(_, lineno)
  self:write("DA:", lineno, ",0\n")
end

function Lcov:on_hit_line(_, lineno, _, hits)
  self:write("DA:", lineno, ",", hits, "\n")
end

function Lcov:on_end_file()
  self:write("end_of_record\n")
end

local out = assert(io.open(out_path, "w"))
local report = setmetatable({ _out = out, _cfg = {}, _data = data, _files = files, _mhit = 0 }, Lcov)
report:run()
report:close()
`;

export const LCOV_SCRIPT = {
  name: 'talos_lcov.lua',
  source: `-- Talos: luacov's statistics as LCOV.\n${BODY}`,
};
