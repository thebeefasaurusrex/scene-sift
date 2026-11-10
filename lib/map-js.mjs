import { parse } from 'acorn';

const nodeName = (node) => node?.name ?? node?.value ?? null;
const functionExpression = (node) => node && ['FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);
const short = (text) => text.replace(/\s+/g, ' ').trim();

export function parseJs(text, file) {
  const options = { ecmaVersion: 'latest', locations: true, allowHashBang: true };
  let tree;
  try {
    tree = parse(text, { ...options, sourceType: 'module' });
  } catch (error) {
    if (!file.endsWith('.js')) throw error;
    tree = parse(text, { ...options, sourceType: 'script' });
  }
  const result = { defs: [], refs: [], imports: [], exports: [] };
  const definitionNames = new Set();
  const called = new Set();
  const references = [];
  function add(kind, name, node, signatureEnd, qualifier, named) {
    const start = node.loc.start.line;
    const sig = short(text.slice(node.start, signatureEnd));
    result.defs.push({
      kind, name, qualified: qualifier ? `${qualifier}.${name}` : name, start, end: node.loc.end.line, sig,
    });
    if (named) definitionNames.add(named.start);
  }

  function walk(node, owner = '', parent) {
    let inside = owner;
    switch (node.type) {
      case 'ClassDeclaration':
      case 'ClassExpression': {
        const named = node.id ?? (parent?.type === 'VariableDeclarator' ? parent.id : null);
        const name = nodeName(named) ?? (parent?.type === 'ExportDefaultDeclaration' ? 'default' : null);
        if (name) {
          const origin = parent?.type === 'VariableDeclarator' ? parent : node;
          add('class', name, origin, node.body.start, owner, named);
          inside = owner ? `${owner}.${name}` : name;
        }
        break;
      }
      case 'FunctionDeclaration':
      case 'VariableDeclarator':
      case 'MethodDefinition':
      case 'Property': {
        const declaration = node.type === 'FunctionDeclaration';
        const expression = declaration ? node : node.type === 'VariableDeclarator' ? node.init : node.value;
        if (!declaration && !functionExpression(expression)) break;
        const named = declaration || node.type === 'VariableDeclarator' ? node.id : node.key;
        const name = nodeName(named) ?? (parent?.type === 'ExportDefaultDeclaration' ? 'default' : null);
        if (typeof name === 'string') {
          add('func', name, node, expression.body.start, owner, named);
          inside = owner ? `${owner}.${name}` : name;
        }
        break;
      }
      case 'ImportDeclaration':
        result.imports.push({ source: node.source.value, spec: short(text.slice(node.start, node.end)), line: node.loc.start.line });
        break;
      case 'ExportDefaultDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        result.exports.push({
          spec: short(text.slice(node.start, node.declaration?.body?.start ?? node.declaration?.start ?? node.end)),
          names: node.type === 'ExportDefaultDeclaration' ? ['default'] :
            node.declaration?.id ? [node.declaration.id.name] :
            node.declaration?.declarations ? node.declaration.declarations.flatMap((decl) => bindingNames(decl.id)) :
            node.specifiers?.map((spec) => nodeName(spec.exported)) ?? [nodeName(node.exported) ?? '*'],
          source: node.source?.value ?? null, line: node.loc.start.line,
        });
        if (node.type === 'ExportDefaultDeclaration' && functionExpression(node.declaration)) {
          add('func', 'default', node.declaration, node.declaration.body.start, owner, node.declaration.id);
        }
        break;
      case 'Identifier':
        references.push(node);
        break;
      case 'CallExpression':
      case 'NewExpression': {
        const callee = node.callee.type === 'MemberExpression' ? node.callee.property : node.callee;
        if (callee.type === 'Identifier') called.add(callee.start);
        break;
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) if (item?.type) walk(item, inside, node);
      } else if (value?.type) walk(value, inside, node);
    }
  }
  walk(tree);
  result.refs = references.filter((node) => !definitionNames.has(node.start)).map((node) =>
    called.has(node.start) ? [node.name, node.loc.start.line, true] : [node.name, node.loc.start.line]);
  return result;
}

function bindingNames(node) {
  switch (node.type) {
    case 'Identifier': return [node.name];
    case 'ObjectPattern': return node.properties.flatMap((item) => bindingNames(item.value ?? item.argument));
    case 'ArrayPattern': return node.elements.filter(Boolean).flatMap(bindingNames);
    case 'RestElement': return bindingNames(node.argument);
    case 'AssignmentPattern': return bindingNames(node.left);
    default: return [];
  }
}
