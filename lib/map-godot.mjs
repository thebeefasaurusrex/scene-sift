const identifier = /[A-Za-z_]\w*/g;
const indent = (line) => line.match(/^\s*/)[0].replaceAll('\t', '    ').length;
const oneLine = (text) => text.replace(/\s+/g, ' ').trim();
const balance = (line) => (line.match(/[[({]/g)?.length ?? 0) - (line.match(/[\])}]/g)?.length ?? 0);

// Keep offsets and line breaks while hiding comments and quoted text from code scans.
function lex(text) {
  const code = text.split('');
  const plain = text.split('');
  let i = 0;
  while (i < text.length) {
    const start = i;
    const char = text[i++];
    if (char === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      for (let j = start; j < i; j++) code[j] = plain[j] = ' ';
    } else if (char === '"' || char === "'") {
      const delimiter = text.startsWith(char.repeat(3), start) ? char.repeat(3) : char;
      i = start + delimiter.length;
      while (i < text.length && !text.startsWith(delimiter, i)) {
        if (text[i] === '\n' && delimiter.length === 1) break;
        i += text[i] === '\\' && i + 1 < text.length ? 2 : 1;
      }
      if (text.startsWith(delimiter, i)) i += delimiter.length;
      for (let j = start; j < i; j++) if (code[j] !== '\n') code[j] = ' ';
    }
  }
  return { code: code.join(''), plain: plain.join('') };
}

function signature(code, start) {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const char = code[i];
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') depth--;
    else if (char === ':' && depth === 0) return i + 1;
    else if (char === '\n' && depth === 0) break;
  }
  return start;
}

export function parseGd(text) {
  const { code, plain } = lex(text);
  const lines = code.split('\n');
  const offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1) + line.length + 1);
  const result = { defs: [], refs: [], sites: [] };
  const classes = [];
  const pendingExports = new Map();
  let functionEnd = -1;
  for (const [index, line] of lines.entries()) {
    if (!line.trim() || index <= functionEnd) continue;
    const depth = indent(line);
    while (classes.length && classes.at(-1).depth >= depth) classes.pop();
    const qualifier = classes.map((item) => item.name).join('.');
    const add = (kind, name, sig, end = index) => result.defs.push({
      kind, name, qualified: qualifier ? `${qualifier}.${name}` : name, start: index + 1, end: end + 1, sig,
    });
    const fn = line.match(/^\s*(?:@\w+(?:\s*\([^)]*\))?\s+)*(?:static\s+)?func\s+([A-Za-z_]\w*)\s*\(/);
    if (fn) {
      const endOffset = signature(code, offsets[index]);
      if (endOffset === offsets[index]) continue;
      let body = index;
      while (offsets[body + 1] < endOffset) body++;
      let end = body;
      let open = balance(code.slice(endOffset, offsets[body + 1]));
      for (let next = body + 1; next < lines.length; next++) {
        if (!lines[next].trim() && !plain.slice(offsets[next], offsets[next + 1]).trim()) continue;
        if (open <= 0 && lines[next].trim() && indent(lines[next]) <= depth) break;
        open += balance(lines[next]);
        end = next;
      }
      add('func', fn[1], oneLine(plain.slice(offsets[index], endOffset)), end);
      functionEnd = end;
      continue;
    }
    const cls = line.match(/^\s*(class_name|class)\s+(\w+)/);
    if (cls) {
      add(cls[1], cls[2], oneLine(plain.slice(offsets[index], offsets[index + 1])));
      if (cls[1] === 'class') classes.push({ name: cls[2], depth });
      continue;
    }
    const field = line.match(/^\s*(extends|signal|const)\s+(\w+)/);
    if (field || /^\s*extends\s/.test(line)) {
      const sig = oneLine(plain.slice(offsets[index], offsets[index + 1]));
      add(field?.[1] ?? 'extends', field?.[2] ?? sig.slice(8), sig);
      continue;
    }
    const exported = /(?:^|\s)@export(?:_(?!group\b|subgroup\b|category\b)\w+)?(?!\w)/.test(line);
    const variable = line.match(/\bvar\s+(\w+)/);
    if (variable && (exported || pendingExports.has(depth))) {
      const sig = oneLine(plain.slice(offsets[index], offsets[index + 1]));
      add('export', variable[1], exported ? sig : pendingExports.get(depth) + ' ' + sig);
    }
    if (exported && !variable) pendingExports.set(depth, oneLine(plain.slice(offsets[index], offsets[index + 1])));
    else if (!line.trimStart().startsWith('@') || variable) pendingExports.delete(depth);
  }

  const byLine = new Map();
  for (const def of result.defs) {
    if (!byLine.has(def.start)) byLine.set(def.start, new Set());
    byLine.get(def.start).add(def.name);
  }
  let index = 0;
  const lineOf = (offset) => {
    while (offsets[index + 1] <= offset) index++;
    return index + 1;
  };
  const callAfter = /\s*\(/y;
  for (const match of code.matchAll(identifier)) {
    const line = lineOf(match.index);
    if (!byLine.get(line)?.has(match[0])) {
      callAfter.lastIndex = match.index + match[0].length;
      const called = callAfter.test(code);
      result.refs.push(called ? [match[0], line, true] : [match[0], line]);
    }
  }
  index = 0;
  const functions = result.defs.filter((item) => item.kind === 'func');
  const sites = /\.\s*new\s*\(|\b(?:instantiate|add_child|preload|load)\s*\(/g;
  for (const match of code.matchAll(sites)) {
    const line = lineOf(match.index);
    let label = match[0].replace(/\s+/g, '').slice(0, -1);
    if (byLine.get(line)?.has(label) && /\bfunc\s+$/.test(code.slice(offsets[line - 1], match.index))) continue;
    if (label === '.new') {
      const receiver = code.slice(offsets[line - 1], match.index).match(/\b[\w.]+\s*$/)?.[0].trim();
      label = (receiver ?? '') + label;
    }
    if (label === 'preload' || label === 'load') {
      const path = plain.slice(match.index + match[0].length).match(/^\s*(['"])([^'"\n]+\.(?:tscn|scn))\1/);
      if (!path) continue;
      label += ' ' + path[2];
    }
    const owner = functions.find((fn) => fn.start <= line && fn.end >= line)?.qualified ?? '<file>';
    result.sites.push({ owner, line, label });
  }
  return result;
}

export function parseScene(text) {
  const resources = new Map();
  const nodes = [];
  let node;
  for (const [index, line] of text.split('\n').entries()) {
    const header = line.trim().match(/^\[(\w+)(.*?)\]$/);
    if (header) {
      node = undefined;
      const attrs = Object.fromEntries([...header[2].matchAll(/(\w+)=("(?:\\.|[^"\\])*"|(?:ExtResource|SubResource)\("[^"]+"\)|\S+)/g)]
        .map(([, key, value]) => [key, value.startsWith('"') ? value.slice(1, -1) : value]));
      if (header[1] === 'ext_resource') resources.set(`ExtResource("${attrs.id}")`, attrs.path ?? attrs.uid);
      if (header[1] === 'sub_resource') resources.set(`SubResource("${attrs.id}")`, attrs.type);
      if (header[1] === 'node' && attrs.name) {
        const path = attrs.parent && attrs.parent !== '.' ? `${attrs.parent}/${attrs.name}` : attrs.name;
        node = { name: attrs.name, path, parent: attrs.parent ?? null, type: attrs.type ?? null, line: index + 1 };
        if (attrs.instance) node.instance = resources.get(attrs.instance) ?? attrs.instance;
        nodes.push(node);
      }
    } else if (node) {
      const script = line.trim().match(/^script\s*=\s*((?:ExtResource|SubResource)\("[^"]+"\))/);
      if (script) node.script = resources.get(script[1]) ?? script[1];
    }
  }
  return { nodes };
}

export function parseProject(text) {
  const settings = { mainScene: null, autoloads: [], inputs: [] };
  let section = '';
  for (const [index, line] of text.split('\n').entries()) {
    const header = line.trim().match(/^\[(\w+)\]$/);
    if (header) section = header[1];
    const entry = line.match(/^([^;=\s][^=]*?)\s*=\s*(.*)$/);
    if (!entry) continue;
    const [, key, value] = entry;
    if (section === 'application' && key === 'run/main_scene') settings.mainScene = value.trim().replace(/^"|"$/g, '');
    if (section === 'autoload') settings.autoloads.push({ name: key, path: value.trim().replace(/^"|"$/g, ''), line: index + 1 });
    if (section === 'input' && value.trimStart().startsWith('{')) settings.inputs.push({ name: key, line: index + 1 });
  }
  return settings;
}
