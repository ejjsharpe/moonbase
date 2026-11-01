# Pi 1.4.0 versioned notice evidence

The installed Durable/AI/Chord 1.4.0 packages declare MIT but contain no LICENSE/NOTICE filenames. The coordinator independently located release-matched upstream material without adding a copied license bundle to Moonbase source.

## Primary release inputs

- Published npm version metadata: [Durable](https://registry.npmjs.org/@earendil-works/pi-durable/1.4.0), [AI](https://registry.npmjs.org/@earendil-works/pi-ai/1.4.0), [Chord](https://registry.npmjs.org/@earendil-works/chord/1.4.0). Each names `earendil-works/pi` and its package directory; none supplies `gitHead`.
- The official [v1.4.0 tag](https://github.com/earendil-works/pi/tree/v1.4.0) resolves through GitHub's ref API to commit `4a080252f06caf63a525d7873c5d94d3c23887e0`.
- [Pinned upstream LICENSE](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/LICENSE), raw URL `https://raw.githubusercontent.com/earendil-works/pi/4a080252f06caf63a525d7873c5d94d3c23887e0/LICENSE`: **1,069 bytes**, SHA-256 `0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48`.
- [Pinned source archive](https://codeload.github.com/earendil-works/pi/tar.gz/4a080252f06caf63a525d7873c5d94d3c23887e0): **8,163,121 bytes**, SHA-256 `677a2912de35585d17193d7facc5f1b4e106f6b2d22a13d101b237aa324726e8`.

## Release correspondence

The passive [verification script](verify-pi-1.4-source.py) compares the normal installed packages to regular files read from that checksum-pinned archive, without extracting paths, importing code or executing lifecycle/build scripts. It verifies package name/version/license/dependencies/peers/optional dependencies/files, byte-identical README files, and **every JavaScript source map's embedded original source** against the pinned upstream `src/` tree.

| Package | JS maps / embedded source contents matched |
| --- | ---: |
| `@earendil-works/pi-durable` 1.4.0 | 84 / 84 |
| `@earendil-works/pi-ai` 1.4.0 | 200 / 200 |
| `@earendil-works/chord` 1.4.0 | 39 / 39 |

All **323** contents match exactly, all seven manifest fields match, all three README files match. [Recorded result](pi-1.4-source-correspondence.json). Run with the downloaded archive and a Bun store containing the installed release:

```sh
python3 docs/research/verify-pi-1.4-source.py /tmp/moonbase-pi-v1.4.0-source.tgz /absolute/path/to/node_modules/.bun
```

This establishes release/source correspondence for provenance; it is not a reproducible-build claim. No upstream source, archive or license text is committed here or selected as an application helper. Packaging that actually ships these SDKs can obtain the pinned upstream text into generated output and verify its digest, rather than inventing a manual source notice bundle.

Full distribution qualification remains open: determine the actual shipped host graph, all transitive notices/runtime assets and target-specific output. The current source CLI and controlled in-memory remote graph are not a distributed host package. The remote graph excludes Pi/Chord/provider/SQLite implementations, so this research does not introduce them into the desktop. Optional engines, real providers/SSH, signing, physical durability and human acceptance remain unqualified. Do not treat this primary text as blanket clearance for unrelated dependencies.
