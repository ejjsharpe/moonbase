import { Effect } from "effect";
import { ApplicationError } from "./client.ts";
import { chatHostVersion, chatProtocolVersion, type ChatHostHealth, type ChatHostTarget } from "./host-client.ts";
import { releaseResource } from "./services.ts";

/** Privileged configuration; never expose this shape through a renderer bridge. */
export type ChatHostEndpoint = { origin: string; token: string; expected: ChatHostTarget };
const maximumHealthBytes = 8 * 1024;
const fail = (code: "InvalidInput" | "Incompatible" | "Unauthorized", message: string): never => { throw new ApplicationError({ code, message }); };
const identity = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value);

function endpointOrigin(endpoint: ChatHostEndpoint): string {
  let url: URL;
  try { url = new URL(endpoint.origin); } catch { return fail("InvalidInput", "Choose an explicit loopback chat endpoint."); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    return fail("InvalidInput", "Chat endpoints must be plain 127.0.0.1 origins without credentials, paths or queries.");
  if (!identity(endpoint.expected?.hostId) || !identity(endpoint.expected?.storeId)) return fail("InvalidInput", "Configure the expected chat host and store identities.");
  if (typeof endpoint.token !== "string" || !/^[\x21-\x7e]{16,4096}$/.test(endpoint.token)) return fail("InvalidInput", "Configure a valid host token outside the renderer.");
  return url.origin;
}

export function validateHostHealth(value: unknown, expected: ChatHostTarget): ChatHostHealth {
  if (!value || typeof value !== "object") return fail("Incompatible", "Chat host returned invalid health data.");
  const data = value as Record<string, unknown>;
  if (!identity(data.hostId) || !identity(data.storeId) || data.hostId !== expected.hostId || data.storeId !== expected.storeId)
    return fail("Incompatible", "Chat host or store identity does not match the configured target.");
  if (data.protocol !== chatProtocolVersion || data.version !== chatHostVersion || !Array.isArray(data.capabilities) ||
      data.capabilities.length > 16 || !data.capabilities.every(value => typeof value === "string" && value.length <= 64) || !data.capabilities.includes("chat-v0"))
    return fail("Incompatible", "Chat host protocol, version or capabilities are incompatible.");
  return { hostId: data.hostId, storeId: data.storeId, protocol: chatProtocolVersion, version: chatHostVersion, capabilities: [...data.capabilities] };
}

/** Verification is an Effect in the caller's existing process scope, never a runtime. */
export const checkHostHealth = (endpoint: ChatHostEndpoint): Effect.Effect<ChatHostHealth, ApplicationError> =>
  Effect.flatMap(Effect.try({ try: () => endpointOrigin(endpoint), catch: ApplicationError.fromUnknown }), origin =>
    Effect.flatMap(Effect.tryPromise({
      try: signal => fetch(`${origin}/v1/health`, {
        headers: { Authorization: `Bearer ${endpoint.token}`, Accept: "application/json" },
        redirect: "error", credentials: "omit", cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      }),
      catch: () => new ApplicationError({ code: "Unavailable", message: "Chat host health could not be reached within its deadline." }),
    }), response => Effect.acquireUseRelease(
      Effect.sync(() => response.body?.getReader()),
      reader => Effect.tryPromise({
        try: async () => {
          if (response.status === 401 || response.status === 403) return fail("Unauthorized", "Chat host rejected authentication.");
          if (!response.ok) return fail("Incompatible", "Chat host health returned an unsuccessful status.");
          if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) return fail("Incompatible", "Chat host health must be JSON.");
          if (!reader) return fail("Incompatible", "Chat host returned empty health data.");
          const chunks: Uint8Array[] = []; let length = 0;
          while (true) {
            const part = await reader.read(); if (part.done) break;
            length += part.value.byteLength;
            if (length > maximumHealthBytes) return fail("Incompatible", "Chat host health exceeds its size limit.");
            chunks.push(part.value);
          }
          const bytes = new Uint8Array(length); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          let value: unknown;
          try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
          catch { return fail("Incompatible", "Chat host returned malformed health JSON."); }
          return validateHostHealth(value, endpoint.expected);
        },
        catch: error => ApplicationError.is(error) ? error : new ApplicationError({ code: "Unavailable", message: "Chat host health could not be read." }),
      }),
      reader => releaseResource(async () => { try { await reader?.cancel(); } finally { reader?.releaseLock(); } }),
    )));
