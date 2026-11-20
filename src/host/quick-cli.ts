import * as vscode from 'vscode';
import path from 'node:path';
import type { CLIRegistration } from '../core/cli-store';
import type { ConversationProvider } from '../providers/conversations';
import { executableInCLIFolder } from '../providers/probe';

export async function addCLIInput(
  provider: ConversationProvider,
  project: string | undefined,
  verify: (executable: string, signal: AbortSignal) => Promise<CLIRegistration>,
) {
  const input = vscode.window.createInputBox();
  // VS Code 1.109 added input button placement. Earlier versions use the title bar.
  const { QuickInputButtonLocation } = vscode as typeof vscode & { QuickInputButtonLocation?: { Input: number } };
  const browse: vscode.QuickInputButton & { location?: number } = {
    iconPath: new vscode.ThemeIcon('folder-opened'),
    tooltip: 'Browse for a CLI installation folder',
    location: QuickInputButtonLocation?.Input,
  };
  const back = vscode.QuickInputButtons.Back;
  const abort = new AbortController();
  let browsing = false;
  let folder = project ? vscode.Uri.file(project) : undefined;
  let registration: CLIRegistration | undefined;
  let customName: string | undefined;

  input.title = `Add ${provider === 'Claude' ? 'Claude Code' : provider} CLI`;
  input.totalSteps = 2;

  function showExecutable() {
    input.step = 1;
    input.buttons = [browse];
    input.placeholder = 'Absolute executable path';
    input.prompt = 'Enter the CLI executable path or browse for its folder.';
    input.value = registration?.executable ?? '';
    input.valueSelection = undefined;
    input.validationMessage = undefined;
  }

  function showName(entry: CLIRegistration) {
    input.step = 2;
    input.buttons = [back];
    input.placeholder = 'CLI name';
    input.prompt = 'Press Enter to add this CLI. Leave the name blank to use the suggested name.';
    input.value = customName ?? entry.name;
    input.valueSelection = [0, input.value.length];
    input.validationMessage = undefined;
  }

  try {
    return await new Promise<CLIRegistration | undefined>(resolve => {
      input.onDidChangeValue(() => { input.validationMessage = undefined; });
      input.onDidHide(() => {
        // The folder dialog temporarily replaces Quick Input, including on remote hosts.
        if (browsing) return;
        abort.abort();
        resolve(undefined);
      });
      input.onDidTriggerButton(async button => {
        if (!input.enabled) return;
        if (button === back) {
          customName = input.value === registration?.name ? undefined : input.value;
          showExecutable();
          return;
        }
        if (button !== browse) return;
        browsing = true;
        input.enabled = false;
        input.hide();
        try {
          const executable = input.value.trim();
          const picked = await vscode.window.showOpenDialog({
            title: 'Choose a CLI installation folder',
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            defaultUri: path.isAbsolute(executable) ? vscode.Uri.file(path.dirname(executable)) : folder,
          });
          if (!picked?.[0]) return;
          folder = picked[0];
          const found = await executableInCLIFolder(provider === 'Codex' ? 'codex' : 'claude', folder.fsPath);
          if (found) input.value = found;
          input.validationMessage = found ? undefined : `No ${provider} executable found in this folder. Browse again or enter its path.`;
        } catch (error) {
          input.validationMessage = error instanceof Error ? error.message : String(error);
        } finally {
          input.enabled = true;
          input.show();
          browsing = false;
        }
      });
      input.onDidAccept(async () => {
        if (!input.enabled) return;
        if (input.step === 2 && registration) {
          if (input.value.length > 80 || /[\x00-\x1f]/.test(input.value)) {
            input.validationMessage = 'Enter a name up to 80 characters without control characters.';
            return;
          }
          resolve({ ...registration, name: input.value.trim() || registration.name });
          return;
        }
        const executable = input.value.trim();
        if (!path.isAbsolute(executable) || executable.length > 4096 || /[\x00-\x1f]/.test(executable)) {
          input.validationMessage = 'Enter a valid absolute path to the CLI executable.';
          return;
        }
        input.enabled = false;
        input.busy = true;
        try {
          if (registration?.executable !== executable) registration = await verify(executable, abort.signal);
          if (!abort.signal.aborted) showName(registration);
        } catch (error) {
          if (!abort.signal.aborted) input.validationMessage = error instanceof Error ? error.message : String(error);
        } finally {
          if (!abort.signal.aborted) {
            input.busy = false;
            input.enabled = true;
          }
        }
      });
      showExecutable();
      input.show();
    });
  } finally {
    input.dispose();
  }
}
