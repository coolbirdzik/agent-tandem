import { parse, type Expression, type CallExpression } from 'acorn';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const outputText = (value: unknown) => typeof object(value).text === 'string' ? object(value).text as string : '';
function successfulPatch(text: string): boolean {
  // The exec bridge serializes a successful apply_patch result as an empty object.
  // Inspect only this call's printed result, never another command's stdout.
  if (text.trim() === '{}') return true;
  try {
    const result = object(JSON.parse(text));
    if (result.isError === true || result.is_error === true || result.error) return false;
    if (Array.isArray(result.content)) text = result.content.map(outputText).join('\n');
  } catch { /* Older bridges print the successful result as plain text. */ }
  return /^Success\. Updated the following files:/m.test(text);
}

/** Read static, awaited patch calls without evaluating code from native history. */
export function execPatches(input: unknown, output: unknown): string[] {
  if (typeof input !== 'string' || !Array.isArray(output) || !/^Script completed\r?\n/.test(outputText(output[0]))) return [];
  let program;
  try { program = parse(input, { ecmaVersion: 'latest', sourceType: 'module' }); } catch { return []; }
  const strings = new Map<string, string>(), results = new Map<string, string | undefined>();
  const literal = (node: Expression): string | undefined => {
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0]?.value.cooked ?? undefined;
    if (node.type === 'Identifier') return strings.get(node.name);
    return undefined;
  };
  const data = (node: Expression): boolean => {
    if (node.type === 'Literal' || node.type === 'Identifier') return true;
    if (node.type === 'TemplateLiteral') return !node.expressions.length;
    if (node.type === 'ArrayExpression') return node.elements.every(value => !value || (value.type !== 'SpreadElement' && data(value)));
    if (node.type === 'ObjectExpression') return node.properties.every(value => value.type === 'Property' && value.kind === 'init' && !value.method && !value.computed && data(value.value as Expression));
    return false;
  };
  const tool = (node: Expression): CallExpression | undefined => {
    if (node.type !== 'AwaitExpression' || node.argument.type !== 'CallExpression') return;
    const call = node.argument, target = call.callee;
    return !call.optional && target.type === 'MemberExpression' && !target.computed && !target.optional && target.object.type === 'Identifier' && target.object.name === 'tools' && target.property.type === 'Identifier' &&
      call.arguments.every(value => value.type !== 'SpreadElement' && data(value)) ? call : undefined;
  };
  const patch = (node: Expression): string | undefined => {
    const call = tool(node);
    return call?.callee.type === 'MemberExpression' && call.callee.property.type === 'Identifier' && call.callee.property.name === 'apply_patch' && call.arguments.length === 1 ? literal(call.arguments[0] as Expression) : undefined;
  };
  const patches: string[] = [];
  let printed = 0;
  for (const statement of program.body) {
    if (statement.type === 'EmptyStatement') continue;
    if (statement.type === 'VariableDeclaration' && statement.kind === 'const') {
      let supported = true;
      for (const declaration of statement.declarations) {
        if (declaration.id.type !== 'Identifier' || !declaration.init || ['text', 'tools'].includes(declaration.id.name)) { supported = false; break; }
        const value = literal(declaration.init);
        if (value !== undefined) strings.set(declaration.id.name, value);
        else if (tool(declaration.init)) results.set(declaration.id.name, patch(declaration.init));
        else { supported = false; break; }
      }
      if (supported) continue;
    } else if (statement.type === 'ExpressionStatement') {
      const call = statement.expression;
      if (call.type === 'CallExpression' && !call.optional && call.callee.type === 'Identifier' && call.callee.name === 'text' && call.arguments.length === 1 && call.arguments[0]?.type !== 'SpreadElement') {
        const value = call.arguments[0]!;
        if (!tool(value) && !data(value)) break;
        const input = patch(value) ?? (value.type === 'Identifier' ? results.get(value.name) : undefined);
        const result = outputText(output[++printed]);
        if (input && successfulPatch(result)) patches.push(input);
        continue;
      }
    }
    // Conditional branches, callbacks, loops and unprinted results do not prove
    // which patch ran. Stop before output positions become ambiguous.
    break;
  }
  return patches;
}
