#!/usr/bin/env python3
"""Build only the approved GitHub Pages files from tracked sources."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
from urllib.parse import urlsplit

SOURCE = Path(__file__).resolve().parent
LICENSES = ("JSZip-LICENSE.md", "PptxGenJS-LICENSE.txt")
PAGES = ("index.html", "DreamStage_PT연습실_v4_AI.html")
SCRIPTS = {
    "LIBPPTX": "pptxgen.bundle.js",
    "LIBZIP": "jszip.min.js",
    "CASES": "cases.js",
    "CONFIG": None,
    "APP": "app.js",
    "AI": "ai.js",
}


def read(name):
    return (SOURCE / name).read_text(encoding="utf-8")


def cases_js(sync):
    cases = json.loads(read("cases.json"))
    if [case["id"] for case in cases] != [f"C{i:02d}" for i in range(1, 19)]:
        raise ValueError("Expected the 18 fictional cases C01–C18")
    expected = "window.PT_CASES=" + json.dumps(
        cases, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ) + ";\n"
    if sync:
        (SOURCE / "cases.js").write_text(expected, encoding="utf-8", newline="\n")
    elif read("cases.js") != expected:
        raise ValueError("Run python source/build.py --sync-cases after editing cases.json")
    return expected


def api_origin(value, allow_local):
    if not value:
        return ""
    if not re.fullmatch(r"https?://[a-zA-Z0-9.-]+(?::[0-9]{1,5})?/?", value):
        raise ValueError("API URL must be an HTTPS origin with no credentials, path, or parameters")
    url = urlsplit(value)
    if url.port == 0 or not url.hostname:
        raise ValueError("Invalid API port or hostname")
    if url.scheme != "https" and not (allow_local and url.hostname in {"127.0.0.1", "localhost"}):
        raise ValueError("Deployment requires an HTTPS API origin")
    return f"{url.scheme}://{url.netloc.lower()}"


def script_hash(script):
    value = base64.b64encode(hashlib.sha256(script.encode("utf-8")).digest()).decode("ascii")
    return f"'sha256-{value}'"


def build(output, api, cases):
    config = {"apiUrl": api, **json.loads(read("contract.json"))}
    scripts = {name: read(src) for name, src in SCRIPTS.items() if src and name != "CASES"}
    scripts["CASES"] = cases
    scripts["CONFIG"] = "const PTLAB_CONFIG = " + json.dumps(config, ensure_ascii=False) + ";"
    scripts = {
        name: re.sub(r"</script", lambda match: "<\\/" + match[0][2:], script, flags=re.I)
        for name, script in scripts.items()
    }
    hashes = " ".join(script_hash(scripts[name]) for name in SCRIPTS)
    connect = f"'self' {api}" if api else "'self'"
    csp = (
        f"default-src 'none'; script-src {hashes}; style-src 'unsafe-inline'; "
        f"img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src {connect}; "
        "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
    )
    values = {**scripts, "CSP": csp, "STYLE": read("style.css")}
    html = re.sub(r"/\*([A-Z]+)\*/", lambda match: values[match[1]], read("shell.html"))

    expected = set(PAGES) | {f"licenses/{name}" for name in LICENSES}
    if output.exists():
        present = {p.relative_to(output).as_posix() for p in output.rglob("*") if p.is_file()}
        if present - expected or output.is_symlink() or (output / "licenses").is_symlink():
            raise ValueError("Use a clean Pages output directory")
    (output / "licenses").mkdir(parents=True, exist_ok=True)
    for name in PAGES:
        (output / name).write_text(html, encoding="utf-8", newline="\n")
    for name in LICENSES:
        shutil.copyfile(SOURCE / "licenses" / name, output / "licenses" / name)
    print(f"Pages build: {len(expected)} files")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=SOURCE.parent / "dist")
    parser.add_argument("--api-url", default=os.environ.get("PTLAB_API_URL"))
    parser.add_argument("--config", type=Path, default=SOURCE / "config.example.json")
    parser.add_argument("--local-test", action="store_true")
    parser.add_argument("--sync-cases", action="store_true")
    args = parser.parse_args()
    try:
        api_url = args.api_url
        if api_url is None:
            api_url = json.loads(args.config.read_text(encoding="utf-8")).get("apiUrl", "")
        if not isinstance(api_url, str):
            raise ValueError("apiUrl must be a string")
        build(args.output, api_origin(api_url, args.local_test), cases_js(args.sync_cases))
    except (ValueError, OSError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
