# SSH provenance

All application/process code and `test/fake-ssh.mjs` are independently authored for Moonbase from the task and frozen application contracts. No escode backend, T3/Pocket/Codex/Microsoft helper, third-party fixture or old user/SSH state was copied or imported. The editor source snapshot was not selected for SSH reuse.

The module uses the existing pinned Effect 4.1.0 dependency, Node standard APIs and the system OpenSSH executable. Local installed OpenSSH 10.2p1 manuals (`ssh`, `ssh_config`) were consulted for argv, local forwarding, configuration output, control sockets, backgrounding and host-key policy. The only actual system SSH test is a no-network `-F /dev/null -G` syntax/configuration expansion for a synthetic `.invalid` destination. No sshd or Remote Login is started, no real host chosen/scanned and no user SSH files are changed.

The fake child implements ordinary loopback TCP piping and controlled failure modes; it is expressly not an SSH/cryptographic/host-key implementation. Tests use newly generated synthetic keys and shared `createHostHealthReply`, never copied credentials or provider data. No executable, third-party source or manually assembled license bundle is shipped. Normal notices remain in installed dependencies and the system OpenSSH distribution. The coordinator owns final distribution dependency/notice/asset qualification.
