"""Apply reviewed text replacements to the embedded HTML of an existing portable build."""
import json
import pathlib
import re
import sys

src, dst, version = sys.argv[1:]
data = pathlib.Path(src).read_bytes()
request = json.loads(pathlib.Path("release-request.json").read_text(encoding="utf-8"))
if request["version"] != version:
    raise SystemExit("Version mismatch")
if not data.startswith(b"MZ"):
    raise SystemExit("Invalid Windows executable")
start = data.index(b"<!doctype html>")
end = data.index(b"</html>", start) + len(b"</html>")
original = data[start:end]
html = original.decode("utf-8")
html = re.sub(r" +</html>$", "</html>", html)
for patch in request["replacements"]:
    old, new = patch["old"], patch["new"]
    if not old or html.count(old) != 1:
        raise SystemExit("Expected exactly one occurrence of each old fragment")
    html = html.replace(old, new, 1)
payload = html.encode("utf-8")
if not payload.endswith(b"</html>") or len(payload) > len(original):
    raise SystemExit("Embedded HTML exceeds available space or is malformed")
payload = payload[:-7] + b" " * (len(original) - len(payload)) + payload[-7:]
result = data[:start] + payload + data[end:]
if len(result) != len(data):
    raise SystemExit("Executable size changed")
pathlib.Path(dst).write_bytes(result)
