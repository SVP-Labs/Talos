# Outside tools

`tools.lock`, at the package's root, pins every tool Talos runs that a project's own dependencies
don't provide: the linters and scanners, `uv`, and the cargo subcommands. `createTools()` reads
it; a check asks `ctx.tools.path(name)` and gets the executable's absolute path.

## The lock

```json
{
  "runtimes": { "python": "3.13.18" },
  "tools": {
    "hadolint": {
      "version": "2.15.1",
      "kind": "binary",
      "platforms": {
        "linux-x64": { "url": "https://…", "sha256": "…", "path": "hadolint" }
      }
    },
    "semgrep": {
      "version": "1.182.1",
      "kind": "pypi",
      "requirements": "tools/semgrep.txt",
      "bin": "semgrep"
    }
  }
}
```

- **Platforms** are Node's `<platform>-<arch>`: `linux-x64`, `linux-arm64`, `darwin-x64`,
  `darwin-arm64`, `win32-x64`, and `any` for a download that serves every machine. A tool lists
  the ones its vendor publishes; asking for it elsewhere is an engine error.
- **Kinds:**
  - `archive`: a `.tar.gz`, `.tar.xz` or `.zip`, unpacked whole; `path` is the executable in it.
  - `binary`: the download is the tool; `path` is the name it is saved under.
  - `psgallery`: a PowerShell Gallery package (a zip); `path` is the module manifest, which the
    check imports by path.
  - `pypi`: installed with `uv` into a virtual environment, from a requirements file under
    `tools/` with a hash for every distribution, wheels only, on the Python `runtimes` pins.
    `bin` is the console script.
- **Runtimes** are the interpreters tools run on; the runtime checks read them like a version
  file.

## The cache

Each tool lands in `<cache>/tools/<name>/<version>/`, where `<cache>` is `TALOS_CACHE` or the
user cache (`~/.cache/talos`, `~/Library/Caches/talos`, `%LOCALAPPDATA%\talos\cache`). A tool is
downloaded with `curl` (which honours `HTTPS_PROXY`), refused unless its sha256 is the pinned
one, unpacked (`tar`, or `unzip`; on Windows the system's `tar.exe` for both), and put in place
with one rename, so concurrent runs never see half a tool. A `.talos-tool` file records the
sha256 (for `pypi`, a hash of the Python version and the requirements) and a mismatch fetches
the tool again. uv's Pythons live in `<cache>/tools/python`.

## Adding or updating a tool

1. Pick a release at least a day old.
2. Download each platform's artefact and compute its sha256 from the downloaded file; record the
   URL, the sum, and the executable's path inside the archive.
3. For a Python tool, write `tools/<name>.in` with the pin and compile it:

   ```bash
   uv pip compile tools/<name>.in --generate-hashes --universal --python-version 3.13 \
     --only-binary :all: --exclude-newer <a day ago> -o tools/<name>.txt
   ```

4. Run `pnpm vitest run src/tools` and the self-test of the checks that use the tool.
