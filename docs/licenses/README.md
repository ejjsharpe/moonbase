# Dependency notices

`stack-manifest.json` records exact installed direct stack packages, their declared licenses and copied notice hashes. These notices apply to the selected dependencies; no old project-specific T3/Codex/VS Code blanket notice was transplanted, because those sources are excluded.

The foundation has no shipping application artifact. The packaging task must inventory the actual renderer/host/native/transitive closure (including Electron's bundled Chromium/Node notices, native tools and any Pi Durable assets), include its notices in the package and record unresolved licensing checks. This direct-stack inventory is not a claim that the future distribution closure is complete. A blocked Windows-only electron-winstaller postinstall is unused by the macOS target; it has not been enabled.
