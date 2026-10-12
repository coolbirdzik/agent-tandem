/** Legacy rollouts encode runtime context as user-role response items. */
export function isRuntimeContextOnly(text: string): boolean {
  const source = text.trim();
  if (!source) return false;
  const blocks = /<(recommended_plugins|environment_context|external_codex_apps_open_page)>([\s\S]*?)<\/\1>/g;
  let end = 0, found = false;
  for (const block of source.matchAll(blocks)) {
    // Only complete context-only messages: never strip snippets, quoted code,
    // or a human request that happens to contain the same tags.
    if (source.slice(end, block.index).trim()) return false;
    const body = block[2]!;
    if (block[1] === 'recommended_plugins') {
      if (!body.trimStart().startsWith('Here is a list of plugins that are available but not installed.')) return false;
    } else if (block[1] === 'environment_context') {
      if (!/<cwd>[\s\S]+?<\/cwd>/.test(body) || !/<shell>[\s\S]+?<\/shell>/.test(body)) return false;
    } else {
      // Work supplies page context as a user-role response item, but native
      // thread/read omits it. Only recognize the complete metadata payload.
      try {
        const page: unknown = JSON.parse(body);
        if (!page || typeof page !== 'object' || Array.isArray(page) || Object.keys(page).length !== 1 || !Object.hasOwn(page, 'page_id')) return false;
        const id = (page as { page_id: unknown }).page_id;
        if (id !== null && typeof id !== 'string') return false;
      } catch { return false; }
    }
    end = block.index! + block[0].length; found = true;
  }
  return found && !source.slice(end).trim();
}
