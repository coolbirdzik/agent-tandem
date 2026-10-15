import { describe, expect, it } from 'vitest';
import { execPatches } from '../src/core/review-exec-patches';
import { captureConversations, conversationEdits } from '../src/core/review-conversations';

const patch = '*** Begin Patch\n*** Update File: source.ts\n@@\n-old\n+new\n*** End Patch';
const call = `text(await tools.apply_patch(${JSON.stringify(patch)}));`;
const output = (...values: string[]) => [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, ...values.map(text => ({ type: 'input_text', text }))];
const conversation = { key: 'Codex:session', id: 'session', provider: 'Codex' as const, title: 'Wrapped patch' };

describe('Codex exec patch evidence', () => {
  it('matches a completed wrapped patch against the saved bytes and capture interval', () => {
    const records = [
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'functions.exec', call_id: 'exec-1', input: call } },
      { type: 'response_item', timestamp: new Date(1200).toISOString(), payload: { type: 'custom_tool_call_output', call_id: 'exec-1', output: output('{}') } },
    ];
    const edits = conversationEdits(records, conversation, '/project', '/project');
    expect(edits).toMatchObject([{ id: 'exec-1', path: 'source.ts', timestamp: 1200 }]);
    expect(captureConversations({ from: 1000, to: 1500 }, 'source.ts', 'old\n', 'new\n', edits)).toEqual([conversation]);
    expect(captureConversations({ from: 1300, to: 1500 }, 'source.ts', 'old\n', 'new\n', edits)).toBeUndefined();
    expect(captureConversations({ from: 1000, to: 1500 }, 'source.ts', 'old\n', 'manual\n', edits)).toBeUndefined();
  });
  it('associates each patch with its own printed result beside shell/test results', () => {
    const second = patch.replace('source.ts', 'other.ts');
    const code = `text(await tools.exec_command({cmd:"read files"})); ${call} text(await tools.apply_patch(${JSON.stringify(second)})); text(await tools.exec_command({cmd:"run failing tests"}));`;
    expect(execPatches(code, output('{"exit_code":0}', '{}', '{"isError":true,"content":[{"text":"Success. Updated the following files:"}]}', '{"exit_code":1}'))).toEqual([patch]);
    expect(execPatches(code, output('{}', 'Patch failed', '{}', 'Success. Updated the following files:'))).toEqual([second]);
  });
  it('reads static constants, template literals and printed awaited results without evaluating them', () => {
    expect(execPatches(`const patch = ${JSON.stringify(patch)}; const result = await tools.apply_patch(patch); text(result);`, output('{}'))).toEqual([patch]);
    expect(execPatches('text(await tools.apply_patch(`' + patch + '`));', output('Success. Updated the following files:\nM source.ts'))).toEqual([patch]);
    expect(execPatches(`const example = ${JSON.stringify(call)}; text(example);`, output(call))).toEqual([]);
    expect(execPatches(`// ${call}\ntext("{}");`, output('{}'))).toEqual([]);
  });
  it.each([
    `if (false) { ${call} }`, `async function later() { ${call} }`, `const later = async () => { ${call} };`,
    `try { ${call} } catch { text("{}"); }`, `await tools.apply_patch(${JSON.stringify(patch)}); text("{}");`,
    `text(await tools.apply_patch(getPatch()));`, `text(await tools.apply_patch(\`${'${getPatch()}'}\`));`,
    `const tools = {}; ${call}`, `const text = () => {}; ${call}`, `exit(); ${call}`, 'invalid JavaScript !',
  ])('ignores conditional, deferred, dynamic or unverifiable code: %s', code => {
    expect(execPatches(code, output('{}'))).toEqual([]);
  });
  it('requires a completed exec, a matching result, and a recorded tool response', () => {
    expect(execPatches(call, [{ type: 'input_text', text: 'Script failed\nOutput:\n' }, { type: 'input_text', text: '{}' }])).toEqual([]);
    expect(execPatches(call, [{ type: 'input_text', text: 'Script running with cell ID 1' }])).toEqual([]);
    expect(execPatches(call, output())).toEqual([]);
    expect(execPatches(call, output('{"isError":true}'))).toEqual([]);
    expect(conversationEdits([{ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'missing', input: call } }], conversation, '/project', '/project')).toEqual([]);
  });
  it('resolves literal Windows paths and rejects sibling workspace paths', () => {
    const code = `text(await tools.apply_patch(${JSON.stringify(patch.replace('source.ts', 'L:/Code/project/src/source.ts'))}));`;
    const records = [
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call', input: code } },
      { type: 'response_item', timestamp: new Date(1200).toISOString(), payload: { type: 'custom_tool_call_output', call_id: 'call', output: output('{}') } },
    ];
    expect(conversationEdits(records, conversation, 'L:\\Code\\project', 'L:\\Code\\project')[0]?.path).toBe('src/source.ts');
    expect(conversationEdits(records, conversation, 'L:\\Code\\project', 'L:\\Code\\project-other')).toEqual([]);
  });
});
