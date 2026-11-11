import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { builtinModules, createRequire } from 'node:module';

// Reuse the parser already required by the pinned StyleX build toolchain.
const stylexRequire = createRequire(import.meta.resolve('@stylexjs/unplugin'));
const { parse } = createRequire(stylexRequire.resolve('@babel/core'))('@babel/parser');

// Keep erased edges: a type-only import still couples public ownership.
export function imports(source, filename) {
  const result = [];
  const tree = parse(source, {
    sourceType: 'unambiguous',
    sourceFilename: filename,
    plugins: ['typescript', 'jsx'],
    createImportExpressions: true,
  });
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (
      ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) &&
      node.source
    ) {
      const typeOnly =
        node.importKind === 'type' ||
        node.exportKind === 'type' ||
        (node.specifiers?.length > 0 &&
          node.specifiers.every(
            (item) => item.importKind === 'type' || item.exportKind === 'type',
          ));
      result.push({ specifier: node.source.value, typeOnly: !!typeOnly });
    } else if (node.type === 'ImportExpression' && node.source.type === 'StringLiteral') {
      result.push({ specifier: node.source.value, typeOnly: false });
    } else if (node.type === 'TSImportType' && node.argument.type === 'StringLiteral') {
      result.push({ specifier: node.argument.value, typeOnly: true });
    } else if (
      node.type === 'TSImportEqualsDeclaration' &&
      node.moduleReference.type === 'TSExternalModuleReference'
    ) {
      result.push({
        specifier: node.moduleReference.expression.value,
        typeOnly: node.importKind === 'type',
      });
    } else if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require' &&
      node.arguments[0]?.type === 'StringLiteral'
    ) {
      result.push({ specifier: node.arguments[0].value, typeOnly: false });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(tree);
  return result;
}

export function readRepository(root) {
  const files = new Map(),
    packages = new Map();
  function walk(directory) {
    for (const item of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (
        /^(?:node_modules|dist|release|test-results|playwright-report|\.git|\.nx)$/.test(item.name)
      )
        continue;
      const path = `${directory}/${item.name}`;
      if (item.isDirectory()) walk(path);
      else if (/\.(?:[cm]?[jt]sx?)$/.test(item.name))
        files.set(path, imports(readFileSync(join(root, path), 'utf8'), path));
    }
  }
  for (const directory of ['packages', 'apps', 'tests']) walk(directory);
  for (const parent of ['packages', 'apps']) {
    for (const item of readdirSync(join(root, parent), { withFileTypes: true })) {
      const directory = `${parent}/${item.name}`;
      if (!item.isDirectory() || !existsSync(join(root, directory, 'package.json'))) continue;
      const manifest = JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8'));
      packages.set(manifest.name, { directory, exports: manifest.exports ?? {} });
    }
  }
  return { files, packages };
}

export const processRoots = new Set([
  'packages/daemon-protocol/examples/remote.ts',
  'packages/workspace/examples/local.ts',
  'packages/ssh/examples/connect.ts',
]);
// The daemon protocol is infrastructure beside the chat engine; neither imports the other.
const infrastructure = new Set(['workspace', 'pi-runtime', 'daemon-protocol', 'ssh']);
const portable = new Set(['application', 'contracts', 'effect']);
// Browser-safe, dependency-free externals portable packages may import.
const portableExternal = /^(?:effect|lru-cache)(?:\/|$)/;
const forbiddenPortable =
  /^(?:node:|electron(?:\/|$)|react(?:-dom)?(?:\/|$)|monaco-editor(?:\/|$)|@effect\/platform|@earendil-works\/|(?:fs|path|crypto|http|net|child_process)$)/;
const owner = (path) => path.match(/^packages\/([^/]+)\//)?.[1];
const moduleOwner = (path) => path.match(/^(?:packages|apps)\/[^/]+/)?.[0];
const production = (path) =>
  /^packages\/[^/]+\/src\//.test(path) || /^packages\/ui\/[^/]+\.ts$/.test(path);

/** Check source ownership separately from emitted bundles, which erase type-only imports. */
export function checkBoundaries({ files, packages }) {
  const errors = [],
    graph = new Map();
  function reject(path, edge, reason) {
    const key = `${path} -> ${edge.specifier}`;
    errors.push(`${key}: ${reason}${edge.typeOnly ? ' (type-only)' : ''}`);
  }
  function target(path, specifier) {
    if (specifier.startsWith('.')) {
      const resolved = normalize(join(dirname(path), specifier));
      return [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}/index.ts`].find((name) =>
        files.has(name),
      );
    }
    const match = specifier.match(/^(@moonbase\/[^/]+)(.*)$/);
    if (!match) return;
    const pkg = packages.get(match[1]);
    if (!pkg) return null;
    const subpath = match[2] ? `.${match[2]}` : '.';
    let exported = pkg.exports[subpath];
    if (!exported) {
      for (const [pattern, value] of Object.entries(pkg.exports)) {
        if (!pattern.includes('*')) continue;
        const [before, after] = pattern.split('*');
        if (subpath.startsWith(before) && subpath.endsWith(after)) {
          exported = value.replace(
            '*',
            subpath.slice(before.length, after ? -after.length : undefined),
          );
          break;
        }
      }
    }
    return typeof exported === 'string' ? normalize(join(pkg.directory, exported)) : null;
  }
  for (const [path, edges] of files) {
    graph.set(path, []);
    for (const edge of edges) {
      const resolved = target(path, edge.specifier);
      if (resolved === null) reject(path, edge, 'not a public package export');
      if (
        edge.specifier.startsWith('.') &&
        resolved &&
        moduleOwner(path) &&
        moduleOwner(resolved) &&
        moduleOwner(path) !== moduleOwner(resolved)
      )
        reject(path, edge, 'cross-package source import; use public exports');
      if (resolved && files.has(resolved)) graph.get(path).push({ ...edge, target: resolved });
      if (processRoots.has(path)) {
        if (
          edge.specifier.startsWith('@moonbase/application') &&
          !/^@moonbase\/application\/runtime\/(?:clients|handlers|effect-client)$/.test(
            edge.specifier,
          )
        )
          reject(
            path,
            edge,
            'process roots consume only public dispatch/runtime APIs from application',
          );
        continue;
      }
      if (!production(path)) continue;
      const sourceOwner = owner(path),
        destination = edge.specifier.match(/^@moonbase\/([^/]+)/)?.[1] ?? owner(resolved ?? '');
      if (portable.has(sourceOwner)) {
        if (forbiddenPortable.test(edge.specifier))
          reject(path, edge, 'platform/UI implementation in portable package');
        if (
          !edge.specifier.startsWith('.') &&
          !edge.specifier.startsWith('@moonbase/') &&
          !portableExternal.test(edge.specifier)
        )
          reject(path, edge, 'portable external dependency is not allowlisted');
        if (
          destination &&
          destination !== sourceOwner &&
          !['contracts', 'effect'].includes(destination)
        )
          reject(path, edge, 'portable package depends on implementation');
        if (sourceOwner === 'contracts' && destination && destination !== 'contracts')
          reject(path, edge, 'contracts depends on executable application/helper');
      }
      if (infrastructure.has(sourceOwner) && destination === 'application')
        reject(path, edge, 'reusable infrastructure depends on application');
      if (
        sourceOwner === 'workbench' &&
        destination &&
        !['workbench', 'application', 'contracts', 'ui'].includes(destination)
      )
        reject(path, edge, 'presentation depends on infrastructure or shared implementation');
      if (
        sourceOwner === 'workbench' &&
        (edge.specifier.startsWith('node:') ||
          builtinModules.includes(edge.specifier) ||
          /^(?:electron(?:\/|$)|@effect\/platform|@earendil-works\/)/.test(edge.specifier) ||
          edge.specifier === '@moonbase/contracts/services' ||
          /^@moonbase\/application\/(?:runtime|testing)\//.test(edge.specifier))
      )
        reject(path, edge, 'platform or privileged capability in browser workbench');
      if (
        sourceOwner === 'workbench' &&
        (/^@moonbase\/application(?:$|\/(?!editor$))/.test(edge.specifier) ||
          /^@moonbase\/contracts\/(?:chat|connection|host)(?:-schema)?$/.test(edge.specifier))
      )
        reject(path, edge, 'project workbench consumes only editor capabilities');
      if (
        sourceOwner === 'workbench' &&
        /^packages\/workbench\/(?:demo|test)\//.test(resolved ?? '')
      )
        reject(path, edge, 'browser presentation reaches a demo/test capability');
      if (
        infrastructure.has(sourceOwner) &&
        destination &&
        destination !== sourceOwner &&
        !['contracts', 'effect', 'application'].includes(destination) &&
        edge.specifier !== '@moonbase/ssh/host-health'
      )
        reject(path, edge, 'infrastructure imports another implementation outside named helper');
    }
  }
  const healthLeaf = 'packages/ssh/src/host-health.ts';
  if (files.has(healthLeaf)) {
    const seen = new Set();
    function visit(path) {
      if (seen.has(path)) return;
      seen.add(path);
      for (const edge of graph.get(path) ?? []) {
        if (
          ['application', 'pi-runtime', 'daemon-protocol', 'workspace', 'ssh'].includes(
            owner(edge.target),
          ) &&
          edge.target !== healthLeaf
        )
          errors.push(
            `${healthLeaf}: named authentication helper reaches implementation ${edge.target}`,
          );
        else visit(edge.target);
      }
    }
    visit(healthLeaf);
  }
  // A host entry-point exception cannot excuse imports reachable from reusable service exports.
  for (const [name, pkg] of packages) {
    if (!infrastructure.has(name.replace('@moonbase/', ''))) continue;
    for (const exported of Object.values(pkg.exports)) {
      if (typeof exported !== 'string') continue;
      const entry = normalize(join(pkg.directory, exported));
      if (!files.has(entry)) continue;
      const seen = new Set();
      function visit(path) {
        if (seen.has(path)) return;
        seen.add(path);
        if (processRoots.has(path))
          errors.push(`${entry}: reusable export reaches process root ${path}`);
        for (const edge of graph.get(path) ?? []) {
          if (owner(edge.target) === 'application')
            reject(path, edge, `application reachable from reusable export ${entry}`);
          else visit(edge.target);
        }
      }
      visit(entry);
    }
  }
  // Runtime file cycles are forbidden. Internal DTO/schema type cycles are permitted;
  // cross-package cycles include type-only edges and are forbidden.
  function cycles(nodes, next, label) {
    const done = new Set(),
      active = new Set();
    function visit(node, route) {
      if (active.has(node)) {
        errors.push(`${label}: ${[...route, node].join(' -> ')}`);
        return;
      }
      if (done.has(node)) return;
      active.add(node);
      for (const child of next(node)) visit(child, [...route, node]);
      active.delete(node);
      done.add(node);
    }
    for (const node of nodes) visit(node, []);
  }
  const sources = [...files.keys()].filter(production);
  cycles(
    sources,
    (path) =>
      (graph.get(path) ?? [])
        .filter((edge) => !edge.typeOnly && production(edge.target))
        .map((edge) => edge.target),
    'runtime source cycle',
  );
  const packageGraph = new Map();
  for (const path of sources) {
    const from = owner(path);
    if (!packageGraph.has(from)) packageGraph.set(from, new Set());
    for (const edge of graph.get(path) ?? []) {
      const to = owner(edge.target);
      if (to && to !== from) packageGraph.get(from).add(to);
    }
  }
  cycles(
    packageGraph.keys(),
    (name) => packageGraph.get(name) ?? [],
    'package cycle including type-only edges',
  );
  return [...new Set(errors)];
}

export const isPrivilegedDesktopInput = (path) =>
  /(?:^|\/)apps\/desktop\/src\/(?:main(?:\/|\.ts$)|(?:session|ipc-lifetime)\.ts$|chat\/(?:config|local|session|transcript-native)\.ts$)/.test(
    path,
  );
