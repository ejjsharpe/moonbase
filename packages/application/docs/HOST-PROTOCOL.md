# Chat host health v1

`@moonbase/application/host-client` exposes browser-safe host/store identity and protocol/application versions. Privileged `@moonbase/application/host-health` exports `checkHostHealth({origin, token, expected})` for the existing runtime and `createHostHealthReply` for the host HTTP handler. [Pi](../../pi-runtime/README.md) serves health; [SSH](../../ssh/README.md) checks it before exposing connectivity.

The operator-provisioned random application key (`token`) stays private on both peers. It never enters renderer commands, HTTP messages, URLs, SSH arguments or logs. The endpoint is a bare HTTP origin on `127.0.0.1`, normally an OpenSSH local forward.

Each GET `/v1/health` generates a fresh 32-byte base64url nonce. Headers carry `X-Moonbase-Nonce` and `Authorization: Moonbase-HMAC-SHA256 <request proof>`. After verifying the proof, the server returns bounded signed JSON:

```json
{ "protocol": 1, "hostId": "configured-host", "storeId": "configured-store", "version": "0.1.0", "capabilities": ["chat-v0"], "nonce": "<request nonce>", "proof": "<response proof>" }
```

Proofs are lowercase hexadecimal HMAC-SHA256 of UTF-8 `JSON.stringify` arrays keyed by the secret string:

- Request: `["moonbase-health-v1", "request", nonce]`.
- Response: `["moonbase-health-v1", "response", nonce, protocol, hostId, storeId, version, capabilities]`.

Distinct domains prevent request reflection; fresh nonces reject old responses. Constant-time comparisons verify proofs. The client returns validated identity fields, stripping proof/nonce and unknown metadata. Read-only health proofs do not authorize [chat RPC](CHAT.md#stateful-loopback-protocol); there is no bearer fallback.

Reject invalid proofs, unexpected host/store, incompatible exact versions, missing capability, malformed/non-JSON/oversized bodies and redirects. Actual body bytes are capped at 8 KiB with a five-second request/body deadline. All outcomes release the reader. Errors never echo supplied bodies or keys: authentication is `Unauthorized`, incompatible health `Incompatible`, network/deadline failure `Unavailable`, invalid local config `InvalidInput`.

Application-key proof supplements OpenSSH machine authentication; it does not encrypt HTTP, prevent live relaying, grant local filesystem access or rebind a conversation's store. Reconnect queries state without sending chat input. Controlled tests cover wrong listeners/keys/identity, reflection/replay/tampering, concurrency, deadlines and cleanup; real SSH remains a separate qualification.
