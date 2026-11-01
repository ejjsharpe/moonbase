# Chat host health v1

This shared boundary prepares independent Pi and SSH modules. It is not a running host, SSH connection or chat implementation. Standalone editor composition does not import it.

`@moonbase/application/host-client` contains browser-safe host/store identities and exact protocol/application versions. `@moonbase/application/host-health` is privileged: `checkHostHealth({ origin, token, expected })` returns an Effect for the existing process runtime. The endpoint and bearer token never enter renderer commands, URLs, SSH arguments or logs.

The configured endpoint is a bare HTTP origin on `127.0.0.1`, normally a system OpenSSH local forward. GET `/v1/health` sends `Authorization: Bearer <token>` and accepts bounded JSON:

```json
{ "protocol": 1, "hostId": "configured-host", "storeId": "configured-store", "version": "0.1.0", "capabilities": ["chat-v0"] }
```

The client rejects wrong authentication, unexpected host/store, incompatible exact versions, missing capability, non-JSON/malformed/oversized responses and redirects. Actual body bytes are capped at 8 KiB; the request/body deadline is five seconds. Cancellation and every success/failure release the response reader. No supplied response body or token is echoed in errors. Authentication failures are `Unauthorized`; incompatible health is `Incompatible`; network/deadline failures are `Unavailable`; invalid local configuration is `InvalidInput`.

This protocol assumes the explicitly configured loopback endpoint and the operator's verified SSH host-key policy. It does not replace SSH host authentication, encrypt arbitrary HTTP or make a TCP listener a chat host. A verified health response grants no filesystem authority and never rebinds an existing conversation to a different store. Reconnect must query state without sending chat input.

Controlled Node HTTP tests cover the boundary, including cancellation and a real stalled-body deadline. They use synthetic credentials, no provider or SSH. Future module/proof checks must establish actual server enforcement, connection ownership, store persistence, client/host transport and packaging; no such qualification is inferred here. Human acceptance remains PENDING.
