import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseGd, parseProject, parseScene } from '../lib/map-godot.mjs';
import { parseJs } from '../lib/map-js.mjs';

const fixture = new URL('../fixtures/map/', import.meta.url);
const read = (file) => readFileSync(new URL(file, fixture), 'utf8');
const ranges = (data) => data.defs.map(({ kind, qualified, start, end }) => [kind, qualified, start, end]);

test('Godot map handles annotated classes, multiline static methods and lambda construction sites', () => {
  const gd = parseGd(read('complex.gd'));
  assert.deepEqual(ranges(gd), [
    ['class_name', 'Workshop', 2, 2], ['extends', 'Node', 3, 3], ['signal', 'prepared', 4, 4],
    ['export', 'seats', 8, 8], ['const', 'ROOM', 9, 9], ['const', 'NOTES', 11, 11],
    ['class', 'Builder', 16, 16], ['extends', 'Builder.RefCounted', 17, 17],
    ['func', 'Builder.make', 18, 27], ['func', 'begin', 29, 33],
  ]);
  assert.equal(gd.defs[8].sig, 'static func make( scene: PackedScene, label: String = "not: the end" ) -> Node:');
  assert.deepEqual(gd.sites.map(({ owner, line, label }) => [owner, line, label]), [
    ['<file>', 9, 'preload res://room.tscn'], ['Builder.make', 23, 'Node.new'],
    ['Builder.make', 25, 'instantiate'], ['Builder.make', 26, 'add_child'],
    ['begin', 31, 'load res://room.tscn'], ['begin', 33, 'add_child'],
  ]);
  assert.equal(gd.refs.some(([name]) => ['false_method', 'quoted_method', 'Imaginary', 'Imposter'].includes(name)), false);
});

test('Godot scene and project maps resolve attached scripts, parent paths and settings', () => {
  assert.deepEqual(parseScene(read('room.tscn')).nodes, [
    { name: 'Room', path: 'Room', parent: null, type: 'Node', line: 6, script: 'res://complex.gd' },
    { name: 'Seats', path: 'Seats', parent: '.', type: 'Node', line: 9 },
    { name: 'Guest', path: 'Seats/Guest', parent: 'Seats', type: null, line: 11, instance: 'res://guest.tscn' },
  ]);
  assert.deepEqual(parseProject(read('project.godot')), {
    mainScene: 'res://room.tscn', autoloads: [{ name: 'Manager', path: '*res://complex.gd', line: 7 }],
    inputs: [{ name: 'confirm', line: 10 }],
  });
});

test('Acorn maps exports, imports, class methods and arrow function ranges', () => {
  const js = parseJs(read('complex.mjs'), 'complex.mjs');
  assert.deepEqual(ranges(js), [
    ['func', 'launch', 3, 3], ['class', 'Engine', 5, 15], ['func', 'Engine.make', 6, 10],
    ['func', 'Engine.step', 12, 14], ['func', 'default', 16, 18],
  ]);
  assert.deepEqual(js.exports.map(({ names }) => names), [['install'], ['launch'], ['Engine'], ['default']]);
  assert.deepEqual(js.imports.map(({ source, line }) => [source, line]), [['./support.mjs', 1]]);
  assert.ok(js.refs.some(([name, line, called]) => name === 'launch' && line === 13 && called));
});

test('SceneSift reuses unchanged files, refreshes before find/show and produces stable artifacts', () => {
  const parent = fileURLToPath(new URL('../.gt/tests/', import.meta.url));
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'map-'));
  cpSync(fileURLToPath(fixture), root, { recursive: true });
  const map = (...args) => {
    const cli = fileURLToPath(new URL('../bin/scene-sift.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [cli, ...args, '--cwd', root], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    return run.stdout;
  };
  assert.match(map('build'), /^STALE SceneSift index rebuilt[^\n]*\nSceneSift 4 files \| 4 parsed \| 0 reused/);
  const index = join(root, '.gt', 'map', 'index.json');
  const first = readFileSync(index);
  assert.match(map('build'), /^SceneSift 4 files \| 0 parsed \| 4 reused/);
  assert.deepEqual(readFileSync(index), first);
  assert.equal(map(), map());
  assert.match(map('find', 'Builder.make'), /DEF complex\.gd:18-27[^\n]+\nCALL complex\.gd:30/);
  const snippet = map('show', 'complex.gd', 'Builder.make', '--full');
  assert.match(snippet, /^18\s+static func make\(/);
  assert.match(snippet, /27\s+return node\n/);
  appendFileSync(join(root, 'complex.gd'), '\nfunc fresh(): pass\n');
  assert.match(map('find', 'fresh'), /^STALE SceneSift index rebuilt[^\n]*\nfresh[^\n]+\nDEF complex\.gd:35/);
  assert.match(map('build'), /^SceneSift 4 files \| 0 parsed \| 4 reused/);
  appendFileSync(join(root, 'complex.mjs'), '\n// Touch only this source.\n');
  assert.match(map('build'), /^STALE SceneSift index rebuilt[^\n]*\nSceneSift 4 files \| 1 parsed \| 3 reused/);
});
