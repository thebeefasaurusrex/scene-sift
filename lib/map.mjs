import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseGd, parseProject, parseScene } from './map-godot.mjs';

const version = 'map/2';
const ignored = new Set(['.git', '.godot', '.gt', 'node_modules', 'build', 'builds', 'dist', 'study', 'captures', 'results']);
const parsers = new Map([['.gd', parseGd], ['.tscn', parseScene], ['.godot', parseProject]]);
const hash = (text) => createHash('sha256').update(text).digest('hex');
const pos = (file, start, end = start) => `${file}:${start}${start === end ? '' : `-${end}`}`;
const functions = (parsed) => parsed.defs?.filter(({ kind }) => kind === 'func') ?? [];
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function sources(root, folder = '') {
  const files = [];
  for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
    const path = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory() && !ignored.has(entry.name)) files.push(...sources(root, path));
    else if (entry.isFile() && (path === 'project.godot' || ['.gd', '.tscn', '.js', '.mjs'].includes(extname(path)))) files.push(path);
  }
  return files;
}

function write(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, value);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function gitState(root) {
  const run = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const top = run('rev-parse', '--show-toplevel');
  if (top.status !== 0 || relative(root, top.stdout.trim())) return null;
  const head = run('rev-parse', '--verify', 'HEAD');
  const status = run('status', '--porcelain', '--untracked-files=normal');
  if (status.status !== 0) throw new Error('Cannot read project git state.');
  return { commit: head.status === 0 ? head.stdout.trim() : null, dirty: !!status.stdout.trim() };
}

async function refresh(root, folder) {
  const cache = join(folder, 'index.json');
  let previous;
  try {
    previous = readJson(cache);
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const entries = {};
  let parsed = 0;
  for (const path of sources(root).sort()) {
    const content = readFileSync(join(root, path));
    const sha256 = hash(content);
    const old = previous?.entries?.[path];
    if (previous?.version === version && old?.sha256 === sha256 && old.data) {
      entries[path] = old;
      continue;
    }
    const extension = extname(path);
    const parser = parsers.get(extension) ?? (await import('./map-js.mjs')).parseJs;
    const text = content.toString('utf8').replace(/^\uFEFF/, '');
    try {
      entries[path] = { sha256, data: parser(text, path) };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error(`Cannot index ${path} | ${error.message}`, { cause: error });
    }
    parsed++;
  }
  const sourceSha256 = hash(JSON.stringify(Object.entries(entries).map(([path, entry]) => [path, entry.sha256])));
  const changed = previous?.version !== version || previous?.sourceSha256 !== sourceSha256;
  if (changed) write(cache, JSON.stringify({ version, sourceSha256, entries }) + '\n');
  return { entries, changed, parsed, sourceSha256 };
}

function settings(data) {
  if (!data) return [];
  return [
    `Main scene ${data.mainScene ?? '(none)'}`,
    `Autoloads ${data.autoloads.map(({ name, path }) => `${name}=${path}`).join(', ') || '(none)'}`,
    `Input actions ${data.inputs.map(({ name }) => name).join(', ') || '(none)'}`,
  ];
}

function outline(entries) {
  const lines = [];
  for (const [file, { data }] of Object.entries(entries)) {
    lines.push(file);
    if (file === 'project.godot') lines.push(...settings(data).map((line) => `  ${line}`));
    for (const node of data.nodes ?? []) {
      const depth = node.parent === null ? 0 : node.parent === '.' ? 1 : node.parent.split('/').length + 1;
      lines.push(`  ${'  '.repeat(depth)}${node.name} [${node.type ?? node.instance ?? 'inherited'}]${node.script ? ` script=${node.script}` : ''} @${node.line}`);
    }
    for (const item of data.defs ?? []) {
      lines.push(`  ${item.start}${item.end === item.start ? '' : `-${item.end}`} ${item.qualified} | ${item.sig}`);
    }
    for (const { spec, line } of data.imports ?? []) lines.push(`  ${line} ${spec}`);
    for (const { names, spec, line } of data.exports ?? []) lines.push(`  ${line} exports ${names.join(', ')} | ${spec}`);
    const sites = new Map();
    for (const site of data.sites ?? []) {
      if (!sites.has(site.owner)) sites.set(site.owner, []);
      sites.get(site.owner).push(`${site.line} ${site.label}`);
    }
    for (const [owner, calls] of sites) lines.push(`  Builds in ${owner} | ${calls.join('; ')}`);
  }
  return lines;
}

function compact(entries, lineBudget) {
  const lines = settings(entries['project.godot']?.data);
  const groups = new Map();
  for (const [file, { data }] of Object.entries(entries)) {
    if (file === 'project.godot') continue;
    const dir = file.includes('/') ? file.split('/')[0] : '.';
    if (!groups.has(dir)) groups.set(dir, []);
    const defs = (data.defs ?? []).filter(({ kind }) => ['func', 'class', 'class_name'].includes(kind));
    const summary = [
      ...defs.slice(0, 3).map(({ name, start }) => `${name}@${start}`),
      ...(defs.length > 3 ? [`+${defs.length - 3} symbols`] : []),
      ...(data.nodes ? [`${data.nodes.length} nodes`] : []),
      ...(data.sites?.length ? [`${data.sites.length} build calls`] : []),
      ...(data.exports?.length ? [`exports ${data.exports.flatMap(({ names }) => names).slice(0, 4).join(', ')}`] : []),
    ].join(', ');
    groups.get(dir).push(`${file} ${summary}`.trimEnd());
  }
  const limit = Math.max(1, lineBudget - lines.length - 1);
  const cap = Math.floor(19000 / Math.min(groups.size || 1, limit));
  for (const [dir, files] of [...groups].slice(0, limit)) {
    let line = `${dir} (${files.length})`;
    let shown = 0;
    for (const file of files) {
      if (line.length + file.length > cap - 48) break;
      line += ` | ${file}`;
      shown++;
    }
    if (shown < files.length) line += ` | +${files.length - shown} files`;
    lines.push(line);
  }
  if (groups.size > limit) lines.push(`+${groups.size - limit} folders in the full outline.`);
  return lines;
}

function find(entries, symbol) {
  const definitions = [];
  const callers = [];
  const references = [];
  const unqualified = symbol.split('.').at(-1);
  for (const [file, { data }] of Object.entries(entries)) {
    for (const def of data.defs ?? []) {
      if (def.name === symbol || def.qualified === symbol) {
        definitions.push(`DEF ${pos(file, def.start, def.end)} | ${def.qualified} | ${def.sig}`);
      }
    }
    if (file === 'project.godot') {
      for (const entry of [...data.autoloads, ...data.inputs]) {
        if (entry.name === symbol) definitions.push(`DEF ${pos(file, entry.line)} | ${entry.name}`);
      }
    }
    for (const node of data.nodes ?? []) {
      if (node.name === symbol) definitions.push(`DEF ${pos(file, node.line)} | ${node.path} | ${node.type ?? node.instance ?? 'inherited'}`);
    }
    for (const item of data.exports ?? []) {
      if (item.names.includes(symbol) && !data.defs.some((def) => def.name === symbol && def.start === item.line)) {
        definitions.push(`EXPORT ${pos(file, item.line)} | ${symbol}`);
      }
    }
    const named = functions(data);
    const lines = new Map();
    for (const [name, line, called] of data.refs ?? []) {
      if (name === unqualified) lines.set(line, called || lines.get(line) || false);
    }
    for (const [line, called] of lines) {
      const owner = named.findLast(({ start, end }) => start <= line && line <= end);
      const list = called ? callers : references;
      list.push(`${called ? 'CALL' : 'REF'} ${pos(file, line)}${owner ? ` | ${owner.qualified}` : ''}`);
    }
  }
  return { definitions, callers, references };
}

export async function map(args) {
  const started = performance.now();
  const { values, positionals: [action = 'outline', ...rest] } = parseArgs({
    args, allowPositionals: true, options: { cwd: { type: 'string' }, full: { type: 'boolean' } },
  });
  const arity = { outline: 0, build: 0, find: 1, show: 2 };
  if (!Object.hasOwn(arity, action) || rest.length !== arity[action]) {
    throw new Error('Use scene-sift [build | find <symbol> | show <file> <function>] [--cwd <path>] [--full].');
  }
  const root = resolve(values.cwd ?? process.cwd());
  const folder = join(root, '.gt', 'map');
  mkdirSync(folder, { recursive: true });
  const state = await refresh(root, folder);
  const { entries } = state;
  const files = Object.keys(entries).length;
  const head = state.changed ? ['STALE SceneSift index rebuilt from current sources.'] : [];
  let path = join(folder, `outline-${state.sourceSha256.slice(0, 16)}.txt`);
  if (!existsSync(path)) write(path, outline(entries).join('\n') + '\n');
  const artifact = (kind) => join(folder, `${kind}-${hash(JSON.stringify([state.sourceSha256, rest])).slice(0, 16)}.txt`);
  const budget = 14 - head.length;
  let lines;
  let code = 0;
  if (action === 'build') {
    lines = [`SceneSift ${files} files | ${state.parsed} parsed | ${files - state.parsed} reused`];
  } else if (action === 'find') {
    const { definitions, callers, references } = find(entries, rest[0]);
    const summary = `${rest[0]} | ${definitions.length} definitions | ${callers.length} call sites | ${references.length} other references`;
    const rows = [...definitions, ...callers, ...references];
    path = artifact('find');
    write(path, [summary, ...rows].join('\n') + '\n');
    lines = [summary, ...rows];
  } else if (action === 'show') {
    const file = rest[0].replaceAll('\\', '/').replace(/^res:\/\/|^\.\//, '');
    const selected = Object.hasOwn(entries, file) ? functions(entries[file].data)
      .filter(({ name, qualified }) => qualified === rest[1] || name === rest[1]) : [];
    if (selected.length !== 1) {
      lines = [selected.length ? 'Multiple functions match. Use the qualified name.' : 'Function not found.',
        ...selected.map((item) => `${pos(file, item.start, item.end)} | ${item.qualified}`)];
      code = 1;
    } else {
      const { start, end } = selected[0];
      const bytes = readFileSync(join(root, file));
      if (hash(bytes) !== entries[file].sha256) throw new Error('Source changed while building the map. Run the command again.');
      lines = bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).slice(start - 1, end)
        .map((line, i) => `${start + i} ${line}`);
      path = artifact('show');
      write(path, lines.join('\n') + '\n');
    }
  } else {
    lines = values.full ? outline(entries) : [`SceneSift ${basename(root)} | ${files} files`, ...compact(entries, budget - 1)];
  }
  write(join(folder, 'stamp.json'), JSON.stringify({
    tool: version, git: gitState(root), sourceSha256: state.sourceSha256,
    engine: { path: process.execPath, version: process.version },
    renderer: null, device: null, seed: null, args, wallTimeMs: Math.round(performance.now() - started),
  }, null, 2) + '\n');
  if (!values.full && lines.length > budget) lines = [...lines.slice(0, budget - 1), `+${lines.length - budget + 1} lines in the full output.`];
  console.log([...head, ...lines, path].join('\n'));
  return code;
}
