import { Effect, Option, type FileSystem } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { isPrivateTo } from '@moonbase/contracts/files';

/** Whether `info` is owned by this process's user and closed to everyone else. */
export const isPrivateFile = (info: FileSystem.File.Info) =>
  isPrivateTo({ uid: Option.getOrElse(info.uid, () => -1), mode: info.mode }, process.getuid?.());

/** The system error code a platform failure carries, such as `ELOOP`. */
export const getErrorCode = (error: PlatformError): unknown =>
  (error.reason as { cause?: { code?: unknown } }).cause?.code;

/** Reads an open file from its current position to its end. */
export const readWholeFile = (file: FileSystem.File) =>
  Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    for (;;) {
      const chunk = yield* file.readAlloc(64 * 1024);
      if (Option.isNone(chunk)) return Buffer.concat(chunks);
      chunks.push(chunk.value);
    }
  });
