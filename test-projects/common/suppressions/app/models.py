import os  # noqa: F401
import subprocess

count: int = "many"  # type: ignore[assignment]
size = len(os.environ)  # pyright: ignore[reportUnknownArgumentType]


def run(command: str) -> None:
    subprocess.run(command, shell=True, check=True)  # nosec B602


if __name__ == "__main__":  # pragma: no cover
    run("true")
