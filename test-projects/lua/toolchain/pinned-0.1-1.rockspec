rockspec_format = "3.0"
package = "pinned"
version = "0.1-1"
source = { url = "git+https://example.invalid/pinned.git" }
dependencies = { "lua >= 5.4", "luacheck == 1.1.2-1" }
build = { type = "builtin", modules = { pinned = "src/pinned.lua" } }
