"""Verify the Pages allowlist and reject likely secrets in publishable material."""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PAGES = {
    "index.html", "DreamStage_PT연습실_v4_AI.html",
    "licenses/JSZip-LICENSE.md", "licenses/PptxGenJS-LICENSE.txt",
}
SECRET = re.compile(
    rb"(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{22,}|gh[pousr]_[A-Za-z0-9]{30,}"
    rb"|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)"
)


def main(output):
    files = {p.relative_to(output).as_posix() for p in output.rglob("*") if p.is_file()}
    assert files == PAGES, "Unexpected Pages artifact contents"
    home = (output / "index.html").read_bytes()
    assert home == (output / "DreamStage_PT연습실_v4_AI.html").read_bytes()
    assert b"data-ai-act" in home and home.count(b"'sha256-") == 6
    for old in (b"/api/configure", b"aiApiKey", b"__PT_TEST"):
        assert old not in home, "Unexpected legacy code"
    tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
    material = [output / name for name in files] + [ROOT / name for name in tracked if name]
    for file in material:
        assert not file.is_symlink(), f"Symlink in release material: {file.name}"
        if file != Path(__file__).resolve():
            assert not SECRET.search(file.read_bytes()), f"Potential credential in {file.name}"
    print(f"Release check: {len(files)} Pages files, {len(tracked) - 1} tracked files")


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())
