"""Passive provenance check; never imports or executes upstream source.

Usage: python3 verify-pi-1.4-source.py SOURCE_ARCHIVE BUN_STORE
Download the pinned archive described in pi-1.4-notice-evidence.md first.
"""
import hashlib
import json
import posixpath
import sys
import tarfile
from pathlib import Path

COMMIT = "4a080252f06caf63a525d7873c5d94d3c23887e0"
ARCHIVE_SHA = "677a2912de35585d17193d7facc5f1b4e106f6b2d22a13d101b237aa324726e8"
archive, store = map(Path, sys.argv[1:])
assert hashlib.sha256(archive.read_bytes()).hexdigest() == ARCHIVE_SHA, "Archive digest changed"
with tarfile.open(archive, "r:gz") as tar:
    # Read regular files only; no archive paths or symlinks are extracted.
    files = {m.name: tar.extractfile(m).read() for m in tar.getmembers() if m.isfile()}
prefix = f"pi-{COMMIT}/"
license_bytes = files[prefix + "LICENSE"]
result = {"commit": COMMIT, "archiveSha256": ARCHIVE_SHA, "packages": []}
fields = ["name", "version", "license", "dependencies", "peerDependencies", "optionalDependencies", "files"]
for name, directory, expected_maps in [("pi-durable", "durable", 84), ("pi-ai", "ai", 200), ("chord", "chord", 39)]:
    matches = list(store.glob(f"@earendil-works+{name}@1.4.0*"))
    assert len(matches) == 1, f"Choose a store with one installed {name} 1.4.0 copy"
    installed = matches[0] / "node_modules" / "@earendil-works" / name
    source_prefix = prefix + f"packages/{directory}/"
    published = json.loads((installed / "package.json").read_text())
    source = json.loads(files[source_prefix + "package.json"])
    assert all(published.get(k) == source.get(k) for k in fields), f"Manifest mismatch: {name}"
    assert (installed / "README.md").read_bytes() == files[source_prefix + "README.md"], f"README mismatch: {name}"
    maps = sorted((installed / "dist").rglob("*.js.map"))
    assert len(maps) == expected_maps, f"Unexpected map set: {name}"
    count = 0
    for path in maps:
        mapping = json.loads(path.read_text())
        assert len(mapping["sources"]) == len(mapping["sourcesContent"])
        for relative, content in zip(mapping["sources"], mapping["sourcesContent"]):
            target = posixpath.normpath(posixpath.join(path.parent.relative_to(installed).as_posix(), mapping.get("sourceRoot", ""), relative))
            assert target.startswith("src/") and isinstance(content, str), f"Unexpected mapped source: {target}"
            assert content.encode() == files[source_prefix + target], f"Source mismatch: {name}/{target}"
            count += 1
    result["packages"].append({"name": published["name"], "version": published["version"], "manifestFieldsMatched": fields, "readmeMatched": True, "maps": len(maps), "sourceContentsMatched": count})
result["license"] = {"bytes": len(license_bytes), "sha256": hashlib.sha256(license_bytes).hexdigest()}
print(json.dumps(result, indent=2))
