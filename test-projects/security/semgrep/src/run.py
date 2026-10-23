import subprocess


def run(command: str) -> int:
    return subprocess.call(command, shell=True)
