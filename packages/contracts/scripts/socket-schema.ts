/**
 * Writes the WebSocket protocol's JSON Schema (`socket-v1.schema.json`) from its Effect Schemas,
 * for clients not written in TypeScript. `--check` fails when the file is out of date.
 */
import { readFile, writeFile } from 'node:fs/promises';
import * as Schema from 'effect/Schema';
import { socketJsonSchemaRoots } from '../src/socket-schema.ts';

const path = new URL('../socket-v1.schema.json', import.meta.url);
const definitions: Record<string, unknown> = {};
const roots: Record<string, unknown> = {};
for (const [name, schema] of Object.entries(socketJsonSchemaRoots)) {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: 'error' });
  roots[name] = document.schema;
  for (const [key, value] of Object.entries(document.definitions)) {
    if (key in definitions && JSON.stringify(definitions[key]) !== JSON.stringify(value))
      throw Error(`Conflicting JSON Schema definition ${key}.`);
    definitions[key] = value;
  }
}
const text = `${JSON.stringify(
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Moonbase daemon WebSocket protocol (socket-v1)',
    description:
      'Messages of GET /v2/socket. Byte bounds and some value checks are enforced by the daemon and not all are expressible here; see packages/contracts/README.md.',
    $defs: { ...definitions, ...roots },
  },
  null,
  2,
)}\n`;
if (process.argv.includes('--check')) {
  const current = await readFile(path, 'utf8').catch(() => '');
  if (current !== text) {
    console.error(
      'socket-v1.schema.json is out of date: run `bun run --cwd packages/contracts socket-schema`.',
    );
    process.exit(1);
  }
} else await writeFile(path, text);
