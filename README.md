# SceneSift

Find definitions, call sites, and other symbol references across Godot scenes, GDScript, and JavaScript. SceneSift keeps a local source index and reparses changed files before answering a query.

## Install

Install Node.js 22.14 or later. From a terminal:

```sh
git clone https://github.com/thebeefasaurusrex/scene-sift.git
cd scene-sift
npm ci
node bin/scene-sift.mjs --help
```

To install the `scene-sift` command from that checkout, run `npm install --global .`. The commands below use the checkout directly.

## Try it

```sh
node bin/scene-sift.mjs --cwd fixtures/map
node bin/scene-sift.mjs build --cwd fixtures/map
node bin/scene-sift.mjs find Builder.make --cwd fixtures/map
node bin/scene-sift.mjs show complex.gd Builder.make --cwd fixtures/map --full
npm test
```

Change `--cwd` to the root of your project, or run the installed command from your project directory. `outline` is the default action. `build` prints the number of files parsed and reused. `find` lists definitions and reference lines, and `show` reads one function. Use `--full` for untruncated output.

SceneSift reads `.gd`, `.tscn`, `.js`, `.mjs`, and the root `project.godot`. Symbol lookup is lexical and runtime resolution can differ. Evidence, snippets, and cached source ranges are written beneath `.gt/map/` in the target project. Add `.gt/` to your ignore file and review any evidence before sharing it.

The sample includes JavaScript and scene fixtures for the indexer. Godot is unnecessary for indexing and running these tests.

## License

Original project code is licensed under [Apache 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
