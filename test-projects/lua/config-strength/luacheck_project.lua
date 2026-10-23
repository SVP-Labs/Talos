-- This project's additions to .luacheckrc, which may only tighten it.
return {
    std = "max",
    ignore = { "212" },
    max_cyclomatic_complexity = 30,
    unused_args = false,
}
