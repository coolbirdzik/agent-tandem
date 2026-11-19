import * as vscode from 'vscode';
import type { ConversationProvider } from '../providers/conversations';
import { quotaAccountHoverHtml, type QuotaAccountHoverState } from '../core/quota-account-hover';

export function quotaAccountHover(provider: ConversationProvider, state: QuotaAccountHoverState): vscode.MarkdownString {
  const md = new vscode.MarkdownString(quotaAccountHoverHtml(provider, state, 'native'), true);
  md.supportHtml = true;
  return md;
}
