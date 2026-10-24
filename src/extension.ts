import * as vscode from 'vscode';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HistoryStore } from './core/history';
import { runDemo } from './core/demo';
import type { Session, ViewState } from './core/types';
import { openChanges, TandemView, selectionFrom, SnapshotDocuments } from './host/preview';
import { openReviewChanges, ReviewDocuments, reviewSnapshotUri } from './host/review-editor';
import { ReviewWebview } from './host/review-webview';
import { registerChangeNavigation, type ChangeNavigationState } from './host/change-navigation';
import { ImageDiff } from './host/image-diff';
import { imageSnapshot, imageSnapshots } from './core/media-preview';
import { gitImageChanges, redirectGitImageDiffs } from './host/git-image-changes';
import { ReviewHunkActions } from './host/review-hunk-actions';
import { probeCodex, probeClaude, cliInfo, installedCLIs } from './providers/probe';
import { ManagedCLIResolver } from './providers/managed-cli';
import { ProjectConversations, claudeMessages, type ClaudeHistoryAPI, type ConversationContent, type ConversationIndex } from './providers/conversations';
import { claudeContent } from './providers/chat-input';
import { UISelectionStore } from './core/ui-selection';
import { readChangePreview } from './core/change-preview';
import { randomUUID } from 'node:crypto';
import { chatRequest, editChat, promptAnswer, questionAnswers, type ChatCallbacks, type PromptAnswer, type ProviderChatRequest } from './providers/chat';
import { runCodexChat } from './providers/codex-chat';
import { runClaudeChat } from './providers/claude-chat';
import { belongsToProject } from './providers/conversations';
import { ReviewStore, type ReviewRequest, type ReviewHunkRequest, type CheckpointPlan } from './core/review';
import { reviewGroup } from './core/review-groups';
import { reviewIgnoredPaths } from './core/review-git';
import { CheckpointStore } from './core/checkpoints';
import { ModelStore } from './core/model-store';
import { EffortStore } from './core/effort-store';
import { FastModeStore } from './core/fast-mode-store';
import { fastModeSelection } from './providers/fast-mode';
import { defaultEfforts, effortSelection, validateEffort } from './providers/effort';
import { defaultModels, modelSelection, validateModel, validateModelCLI } from './providers/models';
import { codexModels, claudeModels } from './providers/model-catalog';
import { readCodexAccount, readClaudeAccount, type ProviderAccountStatus } from './providers/account-status';
import type { ConversationProvider } from './providers/conversations';
import { AccessModeStore } from './core/access-store';
import { accessMode, accessSelection, defaultAccessModes } from './providers/access';
import { CLIStore, type CLIRegistration } from './core/cli-store';
import { cliRequest, cliPathKey, emptyCLIRegistry, type CLIRegistry, type CLIActive } from './providers/cli-registry';
import { ContextStore } from './core/context-store';
import { ChatQueue } from './core/chat-queue';
import { ChatQueueStore } from './core/chat-queue-store';
import { UsageHistory } from './providers/usage-history';
import type { UsageDashboardState, UsageGrouping } from './core/usage-dashboard';
import { QuotaStatusBar, readStatusBarPreferences } from './host/quota-status-bar';
import { STATUS_BAR_CONFIGURATION, statusBarPreferenceChanges } from './core/status-bar-preferences';
import { TrackingStatusBar } from './host/tracking-status-bar';
import { SettingsView } from './host/settings-view';
import { AttachmentStore } from './core/attachment-store';
import { UsageAccountStore } from './core/usage-account-store';
import { UsageAttributionStore, validAssignmentScope, type UsageAssignmentScope } from './core/usage-attribution-store';
import { knownUsageAccounts } from './providers/usage-account-identities';
import { QuotaHistoryStore } from './core/quota-history-store';
import { quotaMeters, quotaObservations, type QuotaObservation } from './core/quota-estimate';
import { quotaTicks, type QuotaTick } from './core/quota-pace';
import { QuotaPaceStore } from './core/quota-pace-store';
import { AccountProfiles, nativeHome, profileIdentityKey } from './core/account-profiles';
import { codexSessionMetadata } from './providers/conversations';
import { AccountManager } from './host/account-manager';
import { QuickAccounts } from './host/quick-accounts';
import { resetCodexUsage } from './providers/codex-usage-reset';
import { isAccountProvider, isChatAccount } from './core/account-providers';
import { DesktopAccounts, desktopExecutable, windowsAntigravityCredential } from './core/desktop-accounts';
import { spawn as launchDesktopProcess } from 'node:child_process';
import { withStorageLock } from './core/storage-lock';
import { StorageManager, type StorageState, type CleanupPlan, type HistoryDeletionPlan, type StorageProgress } from './core/storage';
import { ConversationCleanup, type ConversationCleanupState, type DeletionProgress } from './core/conversation-cleanup';
import { deleteCodexThread } from './providers/codex-history-mutation';
import { addFreed, storageFreed } from './core/storage-freed';
import { shouldWarnStorage, storageSize, storageWarningBytes, type ExtensionStorageUsage } from './core/storage-usage';

export interface ExtensionAPI {
  changeNavigationState(): ChangeNavigationState | undefined;
  reviewWebviewState(): import('./core/review-webview').ReviewEditorState | undefined;
  sessions(): Session[];
  runDemo(delay?: number): Promise<Session>;
  stop(): void;
  history: HistoryStore;
  refreshFromStorage(): Promise<void>;
  syncConversations(): Promise<ConversationIndex>;
  openConversation(key: string): Promise<ConversationContent | undefined>;
  conversation(): ConversationContent | undefined;
  viewState(): ViewState;
  viewResolved(): boolean;
  usageDashboard(): UsageDashboardState;
}

let cancel: AbortController | undefined;
export async function activate(context: vscode.ExtensionContext): Promise<ExtensionAPI> {
  const changeNavigation = await registerChangeNavigation(context);
  const output = vscode.window.createOutputChannel('AgentTandem');
  const history = new HistoryStore(context.globalStorageUri.fsPath);
  const attachments = new AttachmentStore(context.globalStorageUri.fsPath);
  const usageAccounts = new UsageAccountStore(path.join(context.globalStorageUri.fsPath, 'usage'));
  const quotaHistoryStore = new QuotaHistoryStore(path.join(context.globalStorageUri.fsPath, 'usage'));
  const quotaPaceStore = new QuotaPaceStore(path.join(context.globalStorageUri.fsPath, 'usage'));
  const desktopAccounts = new DesktopAccounts(process.platform === 'win32' ? (action, value) => windowsAntigravityCredential(path.join(context.extensionUri.fsPath, 'media', 'antigravity-credential.ps1'), action, value) : undefined);
  const accountProfiles = new AccountProfiles(path.join(context.globalStorageUri.fsPath, 'accounts'), undefined, desktopAccounts);
  let savedQuotaTicks: QuotaTick[] = [];
  let quotaHistory: QuotaObservation[] = [], quotaHistoryError: string | undefined;
  try { quotaHistory = await quotaHistoryStore.read(); }
  catch { quotaHistoryError = 'Could not load quota history. Refresh to retry.'; }
  const reviews = new ReviewStore(path.join(context.globalStorageUri.fsPath, 'reviews'), () => vscode.workspace.isTrusted);
  const checkpoints = new CheckpointStore(path.join(context.globalStorageUri.fsPath, 'checkpoints'));
  let checkpointPlan: { project: string; key?: string; id: string; token: string; plan: CheckpointPlan } | undefined;
  const accessStore = new AccessModeStore(path.join(context.globalStorageUri.fsPath, 'access'));
  const modelStore = new ModelStore(path.join(context.globalStorageUri.fsPath, 'models'));
  const effortStore = new EffortStore(path.join(context.globalStorageUri.fsPath, 'efforts'));
  const fastModeStore = new FastModeStore(path.join(context.globalStorageUri.fsPath, 'fast-mode'));
  const cliStore = new CLIStore(path.join(context.globalStorageUri.fsPath, 'cli'));
  const cliResolver = new ManagedCLIResolver(cliStore);
  const codexExtensionIdentity = () => {
    const extension = vscode.extensions.getExtension('openai.chatgpt');
    return extension ? `${extension.extensionUri.toString()}@${extension.packageJSON.version}` : '';
  };
  let codexExtensionRevision = codexExtensionIdentity();
  const contextStore = new ContextStore(path.join(context.globalStorageUri.fsPath, 'context'));
  let cliInit: Promise<CLIRegistry> | undefined;
  let cliManaging = false;
  const modelJobs = new Map<ConversationProvider, { abort: AbortController; job: Promise<void> }>();
  const accountJobs = new Map<ConversationProvider, { abort: AbortController; job: Promise<void>; previous?: ProviderAccountStatus }>();
  let queueSave = Promise.resolve();
  const activeReviewProjects = new Set<string>();
  let reviewing = false;
  let externalWatcher: vscode.FileSystemWatcher | undefined;
  let externalProject: string | undefined;
  let externalTimer: ReturnType<typeof setTimeout> | undefined;
  let externalDirty = false;
  // Paths changed since the last capture; undefined requires a full capture.
  let externalPaths: Set<string> | undefined;
  let externalJob: Promise<void> | undefined;
  let externalSwitching = false;
  const state: ViewState = { sessions: [], running: false, providers: [], screen: 'changes' };
  let hunkActions: ReviewHunkActions | undefined;
  let reviewEditor: ReviewWebview | undefined;
  state.composeProvider = 'Codex';
  let chatAbort: AbortController | undefined;
  let liveConversation: ConversationContent | undefined;
  let composingNew = false;
  const promptReplies = new Map<string, (answer: PromptAnswer) => void>();
  const nativeImport = new Function('url', 'return import(url)') as (url: string) => Promise<ClaudeHistoryAPI>;
  const source = new ProjectConversations(() => nativeImport(pathToFileURL(path.join(context.extensionUri.fsPath, 'dist/claude-history.mjs')).href));
  let generation = 0;
  let fastModeRevision = 0;
  let selectionGeneration = 0;
  let uiGeneration = 0;
  let syncJob: Promise<ConversationIndex> | undefined;
  // Native conversation deletion pauses history sync instead of failing on the 5-second sync timer.
  let conversationDeleting = false;
  let disposed = false;
  const workspaceIdentity = (vscode.workspace.workspaceFolders ?? []).map(folder => process.platform === 'win32' ? folder.uri.toString().toLowerCase() : folder.uri.toString()).sort().join('\n');
  const queueStore = new ChatQueueStore(context.globalStorageUri.fsPath, workspaceIdentity);
  const chatQueue = new ChatQueue(await queueStore.read());
  const preferences = new UISelectionStore(context.globalStorageUri.fsPath, workspaceIdentity);
  const savedSelection = await preferences.read();
  let selectedConversationKey = savedSelection.conversation;
  function setCurrentRoot(): boolean {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeUri?.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
    const current = folders.find(folder => folder.uri.fsPath === state.project);
    const root = folders.find(folder => folder.uri.toString() === activeFolder?.uri.toString()) ?? current ?? folders[0];
    state.projectName = root?.name;
    if (state.project === root?.uri.fsPath) return false;
    chatAbort?.abort(); liveConversation = undefined; state.chat = undefined; composingNew = false;
    if (state.project) chatQueue.pause(state.project, 'Workspace changed. Resume when you return.');
    externalWatcher?.dispose(); externalWatcher = undefined; externalProject = undefined; clearTimeout(externalTimer); externalDirty = false;
    state.project = root?.uri.fsPath;
    state.accessModes = defaultAccessModes();
    state.selectedModels = defaultModels(); state.modelCatalogs = {};
    state.selectedEfforts = defaultEfforts();
    state.codexFastMode = false;
    fastModeRevision++;
    for (const job of modelJobs.values()) job.abort.abort(); modelJobs.clear();
    for (const job of accountJobs.values()) job.abort.abort(); accountJobs.clear(); state.accounts = {};
    state.conversations = []; state.conversation = undefined; state.changePreview = undefined;
    state.review = undefined; state.reviewPreview = undefined; state.revertPreview = undefined; state.reviewBusy = false;
    state.checkpoints = []; state.checkpointPreview = undefined; state.checkpointUndo = undefined; checkpointPlan = undefined;
    state.syncErrors = []; state.syncedAt = undefined; state.error = undefined;
    generation++; selectionGeneration++; uiGeneration++;
    if (savedSelection.project !== state.project) selectedConversationKey = undefined;
    return true;
  }
  setCurrentRoot();
  async function restoreAccessModes() {
    const project = state.project, previous = state.accessModes;
    if (!project) return;
    const modes = await accessStore.read(project);
    if (!disposed && state.project === project && state.accessModes === previous) state.accessModes = modes;
  }
  async function restoreModels() {
    const project = state.project, previous = state.selectedModels;
    if (!project) return;
    const models = await modelStore.read(project);
    if (!disposed && state.project === project && state.selectedModels === previous) state.selectedModels = models;
  }
  async function restoreEfforts() {
    const project = state.project, previous = state.selectedEfforts;
    if (!project) return;
    const efforts = await effortStore.read(project);
    if (!disposed && state.project === project && state.selectedEfforts === previous) state.selectedEfforts = efforts;
  }
  async function restoreFastMode() {
    const project = state.project, version = generation, revision = fastModeRevision;
    if (!project) return;
    const enabled = await fastModeStore.read(project);
    if (!disposed && generation === version && state.project === project && fastModeRevision === revision) state.codexFastMode = enabled;
  }
  await Promise.all([restoreAccessModes(), restoreModels(), restoreEfforts(), restoreFastMode()]);
  const preview = new TandemView(context.extensionUri, () => state,
    async (command, selected) => vscode.commands.executeCommand(command, selected), report);
  const attributionStore = new UsageAttributionStore(path.join(context.globalStorageUri.fsPath, 'usage'));
  const quotaBar = new QuotaStatusBar(), trackingBar = new TrackingStatusBar(), usageHistory = new UsageHistory(undefined, usageAccounts, path.join(context.globalStorageUri.fsPath, 'usage', 'history-cache'),
    { store: attributionStore, knownAccounts: () => knownUsageAccounts(accountProfiles, state.accounts) });
  const storage = new StorageManager(context.globalStorageUri.fsPath);
  let storageState: StorageState = { status: 'idle', root: storage.root }, cleanupPlan: CleanupPlan | undefined;
  let extensionStorage: ExtensionStorageUsage = { status: 'idle', warningBytes: storageWarningBytes(vscode.workspace.getConfiguration('agentTandem').get('storageWarningMB', 1024)) };
  let storageUsageJob: Promise<void> | undefined;
  let historyDeletionPlan: HistoryDeletionPlan | undefined;
  let storageJob: Promise<void> | undefined;
  let conversationCleanupJob = false;
  const assertConversationCleanupIdle = () => {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before deleting native conversation history.');
    if (chatAbort || reviewing || externalSwitching || state.running || cliManaging) throw new Error('Wait for the active agent to finish before deleting conversations.');
  };
  const conversationCleanup = new ConversationCleanup(async row => {
    assertConversationCleanupIdle();
    if (row.provider === 'Codex') {
      const selection = await managedCLI('Codex', state.project);
      assertConversationCleanupIdle();
      await deleteCodexThread(selection.cli.executable, row.id);
    } else {
      const sdk = await nativeImport(pathToFileURL(path.join(context.extensionUri.fsPath, 'dist/claude-history.mjs')).href);
      if (!sdk.deleteSession) throw new Error('The Claude SDK does not support session deletion.');
      assertConversationCleanupIdle(); await sdk.deleteSession(row.id);
    }
  }, () => new Set([state.conversation?.conversation.key, liveConversation?.conversation.key, ...chatQueue.snapshot().map(queue => queue.conversationKey)].filter((key): key is string => !!key)),
  {}, path.join(context.globalStorageUri.fsPath, 'caches', 'conversation-message-times.json'));
  let conversationCleanupState: ConversationCleanupState = { status: 'idle', roots: conversationCleanup.roots };
  // Compressed transcript dates are read after the list is shown; every cleanup action stops this first.
  let conversationDates: { abort: AbortController; job: Promise<void> } | undefined;
  const stopConversationDates = async () => {
    const current = conversationDates; conversationDates = undefined;
    if (current) { current.abort.abort(); await current.job; }
  };
  const startConversationDates = () => {
    const base = conversationCleanupState;
    if (conversationDates || base.status !== 'ready' || base.plan || !base.dates) return;
    const abort = new AbortController();
    const job = conversationCleanup.resolveDates(base, abort.signal, next => { conversationCleanupState = next; settings.update(); }).then(next => { if (next && !abort.signal.aborted) { conversationCleanupState = next; settings.update(); } }, report)
      .finally(() => { if (conversationDates?.abort === abort) conversationDates = undefined; });
    conversationDates = { abort, job };
  };
  const conversationCleanupDisposed = new AbortController();
  context.subscriptions.push({ dispose: () => { conversationDates?.abort.abort(); conversationCleanupDisposed.abort(); } });
  let usageState: Pick<UsageDashboardState, 'status' | 'data' | 'error'> = { status: 'idle' };
  let usageJob: Promise<void> | undefined, usageAbort: AbortController | undefined;
  let usageConversationTitles: Record<string, string> = {};
  let attributionBusy = false, attributionError: string | undefined, attributionNotice: string | undefined;
  const freedKey = 'agentTandem.storageFreed';
  // Totals only add what a run actually removed, so failed or partial runs never inflate them.
  const recordFreed = (run: Parameters<typeof addFreed>[1]) => context.globalState.update(freedKey, addFreed(context.globalState.get(freedKey), run)).then(undefined, report);
  function dashboardState(): UsageDashboardState {
    const config = vscode.workspace.getConfiguration('agentTandem');
    const grouping = config.get<UsageGrouping>('usageDashboardDefaultGrouping', 'day');
    return { ...usageState, ...accountManager.state, conversationCleanup: conversationCleanupState, extensionStorage, storageFreed: storageFreed(context.globalState.get(freedKey)), attributionBusy, attributionError, attributionNotice, accountSwitchBlocked: chatAbort || reviewing ? 'Finish the active agent turn before switching accounts.' : undefined, conversationTitles: { ...usageConversationTitles, ...Object.fromEntries((state.conversations ?? []).map(row => [row.key, row.title])) }, quotaTicks: savedQuotaTicks, storage: storageState, accounts: state.accounts, quotaHistory, quotaBaselines: quotaHistoryStore.baselines, quotaHistoryError, preferences: { showQuotaInStatusBar: config.get('showQuotaInStatusBar', true),
      grouping: ['day', 'week', 'month'].includes(grouping) ? grouping : 'day', statusBar: readStatusBarPreferences(config) }, activeProvider: state.conversation?.conversation.provider ?? state.composeProvider ?? 'Codex' };
  }
  const settings = new SettingsView(context.extensionUri, dashboardState,
    async (command, value) => vscode.commands.executeCommand(command, value), report);
  const accountManager = new AccountManager(accountProfiles, {
    busy: () => !!chatAbort || reviewing || conversationCleanupState.status === 'cleaning',
    project: () => state.project,
    current: provider => isChatAccount(provider) ? state.accounts?.[provider] : undefined,
    executable: async provider => {
      if (!isChatAccount(provider)) throw new Error('Use Open app for desktop accounts.');
      return (await managedCLI(provider, state.project)).cli.executable;
    },
    openDesktop: async provider => {
      if (!vscode.workspace.isTrusted || vscode.env.remoteName) throw new Error('Open a trusted local workspace to manage desktop sign-ins.');
      let executable = await desktopExecutable(provider);
      if (!executable) {
        const files = await vscode.window.showOpenDialog({ title: `Choose ${provider} executable`, canSelectMany: false, ...(process.platform === 'win32' ? { filters: { Application: ['exe'] } } : {}) });
        if (!files?.[0]) throw new Error('No app selected.');
        executable = files[0].fsPath;
      }
      await new Promise<void>((resolve, reject) => {
        const child = launchDesktopProcess(executable!, [], { detached: true, windowsHide: true, stdio: 'ignore' });
        child.once('error', () => reject(new Error(`Could not open ${provider}.`))); child.once('spawn', () => { child.unref(); resolve(); });
      });
    },
    read: async (profile, signal, options) => {
      signal?.throwIfAborted();
      const provider = typeof profile === 'string' ? profile : profile.provider;
      if (!state.project || !vscode.workspace.isTrusted) throw new Error('Open a trusted local workspace to manage sign-ins.');
      if (!isChatAccount(provider)) {
        if (vscode.env.remoteName) throw new Error('Manage desktop sign-ins from a local extension host.');
        if (typeof profile !== 'string') return accountProfiles.desktopStatus(profile);
        try { return await accountProfiles.desktopStatus(provider); } catch { return { status: 'ready', account: { signedIn: false, method: `${provider} account` }, updatedAt: Date.now() }; }
      }
      const cli = await managedCLI(provider, state.project, signal), env = typeof profile === 'string' ? undefined : accountProfiles.environment(profile);
      const read = async () => {
        signal?.throwIfAborted();
        try {
          if (provider === 'Codex') return await readCodexAccount(state.project!, cli.cli.executable, signal, undefined, env, options);
          const sdk = await nativeImport(pathToFileURL(path.join(context.extensionUri.fsPath, 'dist/claude-history.mjs')).href) as typeof import('./providers/claude-history');
          return await readClaudeAccount(state.project!, sdk.query, cli.cli.executable, signal, env);
        } catch (error) { if (!signal?.aborted) cliResolver.invalidateOnFailure(provider, error); throw error; }
      };
      return typeof profile === 'string' ? read() : withStorageLock(accountProfiles.home(profile.id), read);
    },
    changed: async provider => {
      if (!isChatAccount(provider)) { await accountManager.publish(); return; }
      modelJobs.get(provider)?.abort.abort(); accountJobs.get(provider)?.abort.abort();
      state.modelCatalogs = { ...state.modelCatalogs, [provider]: undefined };
      await loadAccount(provider, true); await loadModels(provider, true); await recordQuotaHistory(); await refreshUsageDashboard();
    },
    resetUsage: async account => {
      if (!state.project || !vscode.workspace.isTrusted) throw new Error('Open a trusted workspace before resetting usage.');
      const project = state.project, cli = await managedCLI('Codex', project);
      const accountKey = profileIdentityKey('Codex', account)!;
      const key = 'agentTandem.pendingCodexResets', attempts = context.globalState.get<Record<string, string>>(key, {});
      const idempotencyKey = attempts[accountKey] || randomUUID();
      await context.globalState.update(key, { ...attempts, [accountKey]: idempotencyKey });
      accountJobs.get('Codex')?.abort.abort();
      const result = await resetCodexUsage(project, cli.cli.executable, account, idempotencyKey);
      const remaining = { ...context.globalState.get<Record<string, string>>(key, {}) }; delete remaining[accountKey];
      await context.globalState.update(key, remaining);
      const status = { ...state.accounts?.Codex, status: 'ready' as const, account: result.account, quota: result.quota, quotaCached: false, error: undefined, updatedAt: result.updatedAt };
      state.accounts = { ...state.accounts, Codex: status }; update();
      await recordQuotaHistory();
      const notice = { reset: 'Codex usage reset. One earned reset was used.', alreadyRedeemed: 'This reset was already applied. Quota refreshed.', nothingToReset: 'No eligible quota window needs a reset. No reset was used.', noCredit: 'No earned Codex resets are available.' }[result.outcome];
      return result.quota.status === 'error' ? `${notice} ${result.quota.detail}` : notice;
    },
    update: () => { settings.update(); quickAccounts.update(); quotaBar.update(state, dashboardState()); },
    switched: async provider => {
      const restart = 'Restart Extension Host';
      const choice = await vscode.window.showInformationMessage(`${provider} account switched. Restart the extension host so the ${provider} extension uses the new sign-in?`, restart, 'Later');
      if (choice !== restart) return;
      if (chatAbort || reviewing) { await vscode.window.showWarningMessage('Finish the active agent turn, then restart the extension host.'); return; }
      await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
    },
    observed: async statuses => {
      savedQuotaTicks = await quotaPaceStore.record(statuses.flatMap(status => {
        const provider = status.account?.method === 'Claude account' ? 'Claude' : 'Codex';
        return quotaTicks(provider, status);
      }));
      quotaHistory = await quotaHistoryStore.record([], statuses.flatMap(status => quotaMeters(status.account?.method === 'Claude account' ? 'Claude' : 'Codex', status)));
    },
  });
  const quickAccounts = new QuickAccounts({ state: dashboardState, publish: () => accountManager.publish(),
    refresh: async signal => {
      await Promise.all([loadAccount('Codex', true, signal), loadAccount('Claude', true, signal)]);
      if (signal.aborted) return;
      await accountManager.refresh(signal);
      if (!signal.aborted) await recordQuotaHistory();
    },
    switch: id => accountManager.action({ action: 'switch', id }),
    resetUsage: () => accountManager.action({ action: 'resetUsage', provider: 'Codex' }),
    open: async page => { await vscode.commands.executeCommand(page === 'dashboard' ? 'agentTandem.openSettings' : 'agentTandem.manageAccounts'); }, report });
  context.subscriptions.push(quickAccounts);
  function update() { state.chatQueue = chatQueue.state(state.project); preview.update(); hunkActions?.update(); reviewEditor?.update(); quotaBar.update(state, dashboardState()); trackingBar.update(state); settings.update(); quickAccounts.update(); }
  async function recordQuotaHistory(data = usageState.data) {
    try {
      const samples = (['Codex', 'Claude'] as const).flatMap(provider => quotaObservations(provider, state.accounts?.[provider], data));
      const meters = (['Codex', 'Claude'] as const).flatMap(provider => quotaMeters(provider, state.accounts?.[provider]));
      quotaHistory = await quotaHistoryStore.record(samples, meters); quotaHistoryError = undefined;
      savedQuotaTicks = await quotaPaceStore.record((['Codex', 'Claude'] as const).flatMap(provider => quotaTicks(provider, state.accounts?.[provider])));
    } catch { quotaHistoryError = 'Could not save quota history. Refresh to retry.'; }
  }
  async function refreshUsageDashboard(): Promise<void> {
    if (disposed) return;
    if (usageJob) return usageJob;
    const abort = new AbortController(); usageAbort = abort;
    usageState = { ...usageState, status: 'loading', error: undefined }; settings.update();
    usageJob = (async () => {
      try {
        const data = await usageHistory.read(abort.signal);
        const titles: Record<string, string> = {};
        const names = await codexSessionMetadata(nativeHome('Codex'));
        for (const [id, row] of names) if (row.title) titles[`Codex:${id}`] = row.title;
        try {
          const sdk = await nativeImport(pathToFileURL(path.join(context.extensionUri.fsPath, 'dist/claude-history.mjs')).href);
          for (const row of await sdk.listSessions({ includeWorktrees: false })) if (row.summary) titles[`Claude:${row.sessionId}`] = row.summary;
        } catch { /* Usage remains available without optional session titles. */ }
        if (!disposed && !abort.signal.aborted) {
          usageConversationTitles = titles;
          usageState = { status: 'ready', data };
          await recordQuotaHistory(data);
        }
      } catch {
        if (!disposed && !abort.signal.aborted) usageState = { ...usageState, status: 'error', error: 'Could not read local usage history. Refresh to try again.' };
      } finally { usageJob = undefined; if (!disposed) settings.update(); }
    })();
    return usageJob;
  }
  function saveQueue() {
    const saved = structuredClone(chatQueue.snapshot());
    queueSave = queueStore.save(saved).catch(error => {
      output.appendLine(`Could not save message queue: ${error instanceof Error ? error.message : 'Storage unavailable.'}`);
      if (!disposed && saved.length) { state.error = 'Queued messages could not be saved. They remain available until this window closes.'; update(); }
    });
    update(); return queueSave;
  }
  function report(error: unknown) {
    state.error = error instanceof Error ? error.message : String(error);
    output.appendLine(state.error); update();
  }
  const cliKey = (provider: ConversationProvider) => provider === 'Codex' ? 'codexExecutable' : 'claudeExecutable';
  const cliModeKey = (provider: ConversationProvider) => provider === 'Codex' ? 'codexCLISelection' : 'claudeCLISelection';
  const cliIdKey = (provider: ConversationProvider) => provider === 'Codex' ? 'codexCLIId' : 'claudeCLIId';
  async function discoverCLIs(providers: ConversationProvider[]): Promise<CLIRegistration[]> {
    const results = await Promise.allSettled(providers.map(async provider => {
      const codexExtension = provider === 'Codex' ? vscode.extensions.getExtension('openai.chatgpt') : undefined;
      const files = await installedCLIs(provider === 'Codex' ? 'codex' : 'claude', codexExtension ? [codexExtension.extensionPath] : []);
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const configured = vscode.workspace.getConfiguration('agentTandem', folder.uri).get<string>(cliKey(provider));
        if (configured && !files.some(file => cliPathKey(file.executable) === cliPathKey(configured))) {
          try { files.push(await cliInfo(provider === 'Codex' ? 'codex' : 'claude', configured)); } catch { /* Missing configured executables stay visible as selection errors. */ }
        }
      }
      return files.map(file => ({ ...file, provider, name: `${provider} ${file.version.replace(/^codex-cli\s+/, '').replace(/ \(Claude Code\)$/, '')}` }));
    }));
    return results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  }
  async function ensureCLIRegistry(): Promise<CLIRegistry> {
    const value = await cliStore.read();
    if (value.initialized || !vscode.workspace.isTrusted) return value;
    if (!cliInit) cliInit = discoverCLIs(['Codex', 'Claude']).then(entries => cliStore.initialize(entries)).finally(() => { cliInit = undefined; });
    return cliInit;
  }
  async function managedCLI(provider: ConversationProvider, project?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before resolving a CLI.');
    let stop!: () => void;
    const stopped = new Promise<never>((_, reject) => { stop = () => reject(new Error('CLI selection cancelled.')); });
    signal?.addEventListener('abort', stop, { once: true });
    try { await Promise.race([ensureCLIRegistry(), stopped]); signal?.throwIfAborted(); }
    finally { signal?.removeEventListener('abort', stop); }
    const config = vscode.workspace.getConfiguration('agentTandem', project ? vscode.Uri.file(project) : undefined);
    const terminal = config.get<string>(cliModeKey(provider)) === 'terminal';
    const codexExtension = provider === 'Codex' ? vscode.extensions.getExtension('openai.chatgpt') : undefined;
    return cliResolver.resolve(provider, {
      terminal, id: config.get<string>(cliIdKey(provider)), executable: config.get<string>(cliKey(provider)),
      codexExtensionPaths: codexExtension ? [codexExtension.extensionPath] : [],
    }, signal);
  }
  async function refreshCLIManager() {
    const project = state.project;
    try {
      const registry = await ensureCLIRegistry(), active: Partial<Record<ConversationProvider, CLIActive>> = {};
      for (const provider of ['Codex', 'Claude'] as const) {
        try { const selection = await managedCLI(provider, project); active[provider] = { id: selection.entry?.id, source: selection.source, ...selection.cli }; }
        catch (error) {
          const config = vscode.workspace.getConfiguration('agentTandem', project ? vscode.Uri.file(project) : undefined);
          const terminal = config.get<string>(cliModeKey(provider)) === 'terminal', configured = terminal ? '' : config.get<string>(cliKey(provider));
          const selectedId = terminal ? '' : config.get<string>(cliIdKey(provider));
          const source = selectedId || configured ? 'project' : terminal ? 'path' : 'default';
          const id = selectedId || (configured ? registry.entries.find(entry => entry.provider === provider && cliPathKey(entry.executable) === cliPathKey(configured))?.id : source === 'default' ? registry.defaults[provider] : undefined);
          active[provider] = { id, source, error: (error as Error).message };
        }
      }
      if (!disposed && project === state.project) { state.cliManager = { registry, active, busy: cliManaging, trusted: vscode.workspace.isTrusted }; update(); }
    } catch (error) {
      if (!disposed && project === state.project) { state.cliManager = { registry: emptyCLIRegistry(), active: {}, busy: cliManaging, trusted: vscode.workspace.isTrusted, error: (error as Error).message }; update(); }
    }
  }
  async function setProjectCLI(provider: ConversationProvider, id: string) {
    if (!state.project) throw new Error('Open a project before selecting its CLI.');
    const registry = await ensureCLIRegistry();
    const entry = id && id !== 'path' ? registry.entries.find(entry => entry.id === id && entry.provider === provider && entry.enabled && !entry.error) : undefined;
    if (id && id !== 'path' && !entry) throw new Error('Choose an enabled CLI.');
    const config = vscode.workspace.getConfiguration('agentTandem', vscode.Uri.file(state.project));
    await config.update(cliKey(provider), entry?.executable ?? '', vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update(cliModeKey(provider), id === 'path' ? 'terminal' : 'default', vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update(cliIdKey(provider), entry?.id ?? '', vscode.ConfigurationTarget.WorkspaceFolder);
  }
  async function loadModels(provider: ConversationProvider, force = false): Promise<void> {
    if (!state.project || disposed || !vscode.workspace.isTrusted) return;
    const existing = modelJobs.get(provider);
    if (existing && !force) return existing.job;
    if (!force && state.modelCatalogs?.[provider]) return;
    existing?.abort.abort();
    const project = state.project, abort = new AbortController();
    const catalog = { status: 'loading' as const, choices: state.modelCatalogs?.[provider]?.choices ?? [] };
    state.modelCatalogs = { ...state.modelCatalogs, [provider]: catalog }; update();
    const current = () => !disposed && project === state.project && state.modelCatalogs?.[provider] === catalog && !abort.signal.aborted;
    const job = (async () => {
      try {
        const selected = await managedCLI(provider, project, abort.signal);
        const cli = selected.cli;
        let choices;
        if (provider === 'Codex') choices = await codexModels(project, cli.executable, abort.signal);
        else {
          const sdk = await nativeImport(pathToFileURL(path.join(context.extensionUri.fsPath, 'dist/claude-history.mjs')).href) as typeof import('./providers/claude-history');
          choices = await claudeModels(project, sdk.query, cli.executable, abort.signal);
        }
        if (current()) state.modelCatalogs = { ...state.modelCatalogs, [provider]: { status: 'ready', choices, cli } };
      } catch (error) {
        if (!abort.signal.aborted) cliResolver.invalidateOnFailure(provider, error);
        if (current()) state.modelCatalogs = { ...state.modelCatalogs, [provider]: { status: 'error', choices: [], error: error instanceof Error ? error.message : 'Could not load models.' } };
      } finally {
        if (modelJobs.get(provider)?.abort === abort) modelJobs.delete(provider);
        if (!disposed && project === state.project) update();
      }
    })();
    modelJobs.set(provider, { abort, job });
    return job;
  }
  async function loadAccount(provider: ConversationProvider, force = false, signal?: AbortSignal): Promise<void> {
    if (!state.project || disposed || signal?.aborted) return;
    if (!vscode.workspace.isTrusted) {
      state.accounts = { ...state.accounts, [provider]: { status: 'error', error: 'Trust the workspace to read the CLI account.' } }; update(); return;
    }
    const existing = accountJobs.get(provider);
    if (existing && !force) return existing.job;
    existing?.abort.abort();
    const project = state.project, abort = new AbortController();
    // Replacing an in-flight poll must retain its last completed snapshot.
    const previous = existing ? existing.previous : state.accounts?.[provider];
    const stop = () => abort.abort(); signal?.addEventListener('abort', stop, { once: true });
    const background = !force && previous?.status === 'ready';
    const loading = { ...previous, status: background ? 'ready' as const : 'loading' as const, quotaCached: background ? previous.quotaCached : !!previous?.quota, error: undefined };
    state.accounts = { ...state.accounts, [provider]: loading }; update();
    const current = () => !disposed && project === state.project && state.accounts?.[provider] === loading && !abort.signal.aborted;
    const job = (async () => {
      try {
        const selected = await managedCLI(provider, project, abort.signal);
        let account;
        if (provider === 'Codex') account = await readCodexAccount(project, selected.cli.executable, abort.signal);
        else {
          const sdk = await nativeImport(pathToFileURL(path.join(context.extensionUri.fsPath, 'dist/claude-history.mjs')).href) as typeof import('./providers/claude-history');
          account = await readClaudeAccount(project, sdk.query, selected.cli.executable, abort.signal);
        }
        if (current()) {
          account = await accountManager.rememberQuota(provider, account);
          if (current()) state.accounts = { ...state.accounts, [provider]: account };
        }
      } catch (error) {
        if (!abort.signal.aborted) cliResolver.invalidateOnFailure(provider, error);
        if (current()) state.accounts = { ...state.accounts, [provider]: { ...previous, status: 'error', quotaCached: !!previous?.quota, error: `Could not read ${provider} account. Check the selected CLI and sign-in, then refresh.` } };
      } finally {
        signal?.removeEventListener('abort', stop);
        if (!disposed && project === state.project && state.accounts?.[provider] === loading && abort.signal.aborted) state.accounts = { ...state.accounts, [provider]: previous };
        if (accountJobs.get(provider)?.abort === abort) accountJobs.delete(provider);
        if (!disposed && project === state.project) update();
      }
    })();
    accountJobs.set(provider, { abort, job, previous }); return job;
  }
  async function refreshAccounts() {
    await Promise.all((['Codex', 'Claude'] as const).map(provider => loadAccount(provider)));
    await recordQuotaHistory();
    await refreshUsageDashboard();
    await accountManager.publish();
    if (settings.visible && !accountManager.state.accountsBusy && accountManager.state.managedAccounts?.length) await accountManager.refresh();
  }
  function resetAccounts() {
    for (const job of accountJobs.values()) job.abort.abort(); accountJobs.clear(); state.accounts = {}; refreshAccounts();
  }
  function scheduleExternalCapture() {
    clearTimeout(externalTimer);
    if (disposed || !externalProject || !externalDirty) return;
    externalTimer = setTimeout(() => { void captureExternalReview().catch(report); }, 800);
  }
  function configureExternalWatcher(project: string, enabled: boolean) {
    if (enabled && externalProject === project && externalWatcher) return;
    externalWatcher?.dispose(); externalWatcher = undefined; externalProject = undefined;
    clearTimeout(externalTimer); externalDirty = false; externalPaths = undefined;
    if (!enabled || !vscode.workspace.isTrusted || disposed) return;
    externalProject = project;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(project, '**/*'));
    const changed = (uri: vscode.Uri) => {
      const name = path.relative(project, uri.fsPath).replace(/\\/g, '/');
      if (name.startsWith('../') || name.split('/').some(part => ['.git', 'node_modules', '.test-runtime'].includes(part)) || /\.agent-tandem-revert$/.test(name)) return;
      externalPaths?.add(name); if (externalPaths && externalPaths.size > 2000) externalPaths = undefined;
      externalDirty = true; scheduleExternalCapture();
    };
    const events = [watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed)];
    const dispose = watcher.dispose.bind(watcher);
    watcher.dispose = () => { for (const event of events) event.dispose(); dispose(); };
    externalWatcher = watcher;
    // Catch writes made while VS Code was closed or another root was selected.
    externalDirty = true; scheduleExternalCapture();
  }
  async function captureExternalReview(manual = false) {
    const project = state.project, version = generation;
    if (!project || !state.review?.externalTracking || !vscode.workspace.isTrusted) return;
    if (externalJob) { await externalJob; if (externalDirty) scheduleExternalCapture(); return; }
    if (reviewing || chatAbort || externalSwitching) { scheduleExternalCapture(); return; }
    clearTimeout(externalTimer); externalDirty = false;
    const paths = externalPaths && [...externalPaths], pending = new Set(state.review.files.map(file => file.path));
    externalPaths = new Set();
    const job = (async () => {
      // Build output in ignored folders changes constantly but can never become a review.
      if (!manual && paths?.length && !paths.some(name => pending.has(name))) {
        const ignored = await reviewIgnoredPaths(project, paths);
        if (paths.every(name => ignored.has(name))) return;
      }
      // Background captures keep every view steady; only a requested refresh shows progress.
      if (manual) { state.reviewBusy = true; update(); }
      let changed = false;
      try {
        const captured = await reviews.scanExternal(project);
        const result = await attributeExternalReview(project, captured);
        // A turn that started meanwhile publishes the newer review state itself.
        if (!disposed && generation === version && state.project === project && !chatAbort && !activeReviewProjects.has(project) && JSON.stringify(result) !== JSON.stringify(state.review)) {
          if (result.revision !== state.review?.revision) state.reviewPreview = undefined;
          state.review = result; changed = true;
        }
      } finally {
        if (!disposed && generation === version && state.project === project && (manual || changed)) { if (manual) state.reviewBusy = false; update(); }
      }
    })();
    externalJob = job;
    try { await job; } finally { if (externalJob === job) externalJob = undefined; if (externalDirty) scheduleExternalCapture(); }
  }
  async function attributeExternalReview(project: string, review: NonNullable<ViewState['review']>, index?: ConversationIndex) {
    const unresolved = review.files.flatMap(file => file.captures ?? []).filter(capture => !capture.conversations?.length && capture.from > 0);
    if (!unresolved.length || review.busy) return review;
    // Filesystem mtimes can lag behind timestamps inside native histories (for
    // example after a clock change or sync). Only the tool evidence can decide
    // whether an edit overlaps a capture; cached histories keep retries cheap.
    const conversations = (index ?? await source.list(project)).conversations;
    const edits = [];
    // Read changed native histories, without starting either provider or rewriting its files.
    for (let i = 0; i < conversations.length; i += 8) {
      const results = await Promise.allSettled(conversations.slice(i, i + 8).map(conversation => source.edits(conversation, project)));
      for (const result of results) if (result.status === 'fulfilled') edits.push(...result.value);
    }
    return edits.length ? reviews.attributeConversations(project, edits) : review;
  }
  // Review actions wait for a background capture instead of failing.
  async function settleExternalCapture() { while (externalJob) await externalJob.catch(() => undefined); }
  async function refreshReview(project = state.project, recover = false) {
    if (!project) return;
    let review = await reviews.read(project);
    if (recover && review.busy && !activeReviewProjects.has(project)) review = await reviews.finish(project, undefined, true);
    if (vscode.workspace.isTrusted) {
      try { review = await reviews.initializeExternalTracking(project, vscode.workspace.getConfiguration('agentTandem', vscode.Uri.file(project)).get('autoTrackExternalChanges', true)); }
      catch (error) { review = { ...review, notice: `Automatic tracking could not start: ${error instanceof Error ? error.message : String(error)}` }; report(error); }
    }
    const undo = await checkpoints.undo(project);
    if (!disposed && state.project === project) { state.review = review; state.checkpointUndo = undo; configureExternalWatcher(project, !!review.externalTracking); update(); }
  }
  await refreshReview(state.project, true).catch(report);
  async function openConversation(key: string): Promise<ConversationContent | undefined> {
    const conversation = state.conversations?.find(item => item.key === key);
    if (!conversation || !state.project) throw new Error('Choose a conversation from this project.');
    selectedConversationKey = key;
    const selected = ++selectionGeneration, projectGeneration = generation, project = state.project;
    const queued = chatQueue.state(project);
    if (queued && queued.conversationKey !== key) { chatQueue.pause(project, 'Another conversation opened. Resume queued messages when ready.'); void saveQueue(); }
    composingNew = false;
    const [content] = await Promise.all([liveConversation?.conversation.key === key ? Promise.resolve(liveConversation) : source.read(conversation, state.project), preferences.save({ project: state.project, conversation: key })]);
    const savedUsage = await contextStore.read(content.conversation.cwd, key, content.conversation.revision, content.conversation.updatedAt);
    const savedCheckpoints = await checkpoints.list(project, content);
    if (savedUsage) content.usage = { ...content.usage, ...savedUsage };
    if (!disposed && selected === selectionGeneration && projectGeneration === generation) {
      if (state.conversation?.conversation.key !== key) { state.checkpointPreview = undefined; checkpointPlan = undefined; }
      state.checkpoints = savedCheckpoints;
      state.conversation = content; state.composeProvider = content.conversation.provider; update(); void loadModels(content.conversation.provider);
    }
    return content;
  }
  function syncConversations(background = false): Promise<ConversationIndex> {
    if (syncJob) return syncJob;
    // Deleting rewrites native session indexes; the sync after deletion picks up the result.
    if (conversationDeleting) return Promise.resolve({ conversations: state.conversations ?? [], errors: state.syncErrors ?? [] });
    if (!state.project) return Promise.resolve({ conversations: [], errors: [] });
    const project = state.project, version = generation, selectedAtStart = selectionGeneration;
    if (!background || !state.syncedAt) { state.syncing = true; update(); }
    syncJob = (async () => {
      const index = await source.list(project);
      if (disposed || version !== generation) return index;
      if ((state.review?.files.length || state.review?.undo) && !chatAbort && !reviewing && !externalJob && !externalSwitching) {
        const review = await attributeExternalReview(project, await reviews.read(project), index);
        if (disposed || version !== generation) return index;
        if (state.review?.revision !== review.revision) {
          state.revertPreview = undefined; state.reviewPreview = undefined;
          await changeNavigation.refreshReview(project, review.files.map(file => ({ file: file.path, original: reviewSnapshotUri(file.before, file.path), modified: reviewSnapshotUri(file.after, file.path), review: { project, revision: review.revision, group: reviewGroup(file) } })));
          if (disposed || version !== generation) return index;
        }
        state.review = review;
      }
      state.conversations = index.conversations; state.syncErrors = index.errors; state.syncedAt = Date.now();
      if (liveConversation && state.chat?.status === 'running' && !state.conversations.some(item => item.key === liveConversation!.conversation.key)) state.conversations.unshift(liveConversation.conversation);
      const previous = state.conversation?.conversation;
      if (previous && selectedAtStart === selectionGeneration && !(state.chat?.status === 'running' && previous.key === liveConversation?.conversation.key)) {
        const fresh = index.conversations.find(item => item.key === previous.key);
        if (!fresh && previous.key !== liveConversation?.conversation.key) { selectionGeneration++; state.conversation = undefined; }
        else if (fresh && fresh.revision !== previous.revision) {
          if (liveConversation?.conversation.key === fresh.key) liveConversation = undefined;
          try { await openConversation(fresh.key); }
          catch (error) { state.syncErrors.push(error instanceof Error ? error.message : 'Could not refresh conversation.'); }
        }
      }
      else if (!previous && !composingNew && selectedAtStart === selectionGeneration) {
        const restored = index.conversations.find(item => item.key === selectedConversationKey) ?? index.conversations[0];
        try { if (restored) await openConversation(restored.key); }
        catch (error) { state.syncErrors.push(error instanceof Error ? error.message : 'Could not restore conversation.'); }
      }
      return index;
    })().finally(() => { syncJob = undefined; state.syncing = false; if (!disposed) update(); });
    return syncJob;
  }
  try { state.sessions = await history.sessions(); } catch (error) { report(error); }
  const documents = new SnapshotDocuments(history, () => state.sessions);
  const reviewDocuments = new ReviewDocuments(reviews.history);
  const imageDiff = new ImageDiff(context.extensionUri, async file => {
    if (file.original.scheme === 'agenttandem-review' && file.modified.scheme === 'agenttandem-review') {
      return imageSnapshots(reviews.history, file.file, reviewDocuments.blob(file.original), reviewDocuments.blob(file.modified));
    }
    if (file.original.scheme === 'agenttandem-snapshot' && file.modified.scheme === 'agenttandem-snapshot') {
      const [before, after] = await Promise.all([documents.blob(file.original), documents.blob(file.modified)]);
      return imageSnapshots(history, file.file, before, after);
    }
    if (file.original.scheme === 'git') {
      // Git serves the index/HEAD side; an absent object (added or deleted file) reads as a missing side.
      const read = (uri: vscode.Uri) => vscode.workspace.fs.readFile(uri).then(bytes => bytes, () => undefined);
      const [before, after] = await Promise.all([read(file.original), read(file.modified)]);
      return { before: imageSnapshot(file.file, before), after: imageSnapshot(file.file, after) };
    }
  });
  changeNavigation.imageDiff = (file, title) => imageDiff.open(file, title);
  context.subscriptions.push(imageDiff);
  context.subscriptions.push(output, preview, settings, quotaBar, trackingBar, documents, reviewDocuments,
    vscode.window.registerWebviewViewProvider('agentTandem.panel', preview, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider('agenttandem-snapshot', documents),
    vscode.workspace.registerTextDocumentContentProvider('agenttandem-review', reviewDocuments));

  const run = async (delay?: number) => {
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before running the local fixture demo.');
    if (state.running) throw new Error('A demo is already running.');
    state.running = true; state.error = undefined; cancel = new AbortController();
    await vscode.commands.executeCommand('setContext', 'agentTandem.running', true); update();
    try {
      const session = await runDemo(history, path.join(context.globalStorageUri.fsPath, 'fixtures'), cancel.signal, value => {
        const index = state.sessions.findIndex(session => session.id === value.id);
        if (index === -1) state.sessions.unshift(value); else state.sessions[index] = value;
        update();
      }, delay);
      output.appendLine(`Demo ${session.id}: ${session.status}, ${session.steps.length} captured steps.`);
      return session;
    } finally {
      state.running = false; cancel = undefined;
      await vscode.commands.executeCommand('setContext', 'agentTandem.running', false); update();
    }
  };
  const register = (name: string, handler: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(name, async (...args: unknown[]) => {
    try { return await handler(...args); } catch (error) { report(error); throw error; }
  }));
  register('agentTandem.open', () => { state.screen = 'changes'; update(); return preview.open(); });
  register('agentTandem.openInTab', () => preview.openInTab());
  for (const action of ['newChat', 'history', 'review', 'refresh', 'more'] as const) {
    register(`agentTandem.header.${action}`, () => preview.headerAction(action));
  }
  const openImageChanges = async (target: unknown) => {
    const { files, index } = await gitImageChanges(target);
    await changeNavigation.openFile(files, 'Git image changes', index);
  };
  register('agentTandem.openImageChanges', openImageChanges);
  context.subscriptions.push(redirectGitImageDiffs(openImageChanges, report));
  const storageAction = async (operation: () => Promise<StorageState>) => {
    if (storageJob) throw new Error('Wait for storage management to finish.');
    storageState = { ...storageState, status: 'loading', error: undefined, progress: undefined }; settings.update();
    const job = (async () => {
      try { storageState = await operation(); }
      catch (error) { cleanupPlan = undefined; historyDeletionPlan = undefined; storageState = { ...storageState, status: 'error', plan: undefined, historyPlan: undefined, progress: undefined, error: error instanceof Error ? error.message : String(error) }; throw error; }
      finally { settings.update(); void refreshStorageUsage(true); }
    })();
    storageJob = job;
    try { await job; } finally { if (storageJob === job) storageJob = undefined; }
  };
  function refreshStorageUsage(force = false): Promise<void> {
    if (disposed) return Promise.resolve();
    extensionStorage = { ...extensionStorage, warningBytes: storageWarningBytes(vscode.workspace.getConfiguration('agentTandem').get('storageWarningMB', 1024)) };
    if (storageUsageJob) return storageUsageJob;
    if (!force && extensionStorage.checkedAt && Date.now() - extensionStorage.checkedAt < 5 * 60000) return Promise.resolve();
    extensionStorage = { ...extensionStorage, status: 'loading', error: undefined };
    quotaBar.update(state, dashboardState()); settings.update();
    storageUsageJob = (async () => {
      try {
        const usage = await storage.usage(); if (disposed) return;
        extensionStorage = { ...usage, status: 'ready', checkedAt: Date.now(), warningBytes: extensionStorage.warningBytes };
        const warningKey = 'agentTandem.storageWarningShown';
        if (shouldWarnStorage(extensionStorage, context.globalState.get(warningKey))) {
          await context.globalState.update(warningKey, { at: Date.now(), warningBytes: extensionStorage.warningBytes });
          void vscode.window.showWarningMessage(`AgentTandem data uses ${storageSize(usage.total)} (alert at ${storageSize(extensionStorage.warningBytes)}). Review restore history, attachments and unused snapshots in Storage.`, 'Manage storage').then(choice => {
            if (choice === 'Manage storage' && !disposed) void vscode.commands.executeCommand('agentTandem.openExtensionStorage');
          });
        }
      } catch { if (!disposed) extensionStorage = { ...extensionStorage, status: 'error', error: 'Could not measure extension data. Open Storage to inspect.', checkedAt: Date.now() }; }
      finally { storageUsageJob = undefined; if (!disposed) { quotaBar.update(state, dashboardState()); settings.update(); } }
    })();
    return storageUsageJob;
  }
  const conversationCleanupAction = async (operation: () => Promise<ConversationCleanupState>, cleaning = false) => {
    if (conversationCleanupJob) throw new Error('Wait for conversation cleanup to finish.');
    conversationCleanupJob = true;
    conversationCleanupState = { ...conversationCleanupState, status: cleaning ? 'cleaning' : 'loading', error: undefined, plan: undefined, dates: undefined, done: 0, total: conversationCleanupState.plan?.conversations.length };
    settings.update();
    try {
      await stopConversationDates();
      if (cleaning) {
        // Let a sync already in flight finish; no new one starts until deletion ends.
        conversationDeleting = true; await syncJob?.catch(() => undefined);
        assertConversationCleanupIdle();
      }
      conversationCleanupState = await operation();
    }
    catch (error) {
      conversationCleanup.cancel();
      conversationCleanupState = { ...conversationCleanupState, status: 'error', plan: undefined, error: error instanceof Error ? error.message : String(error) };
      throw error;
    } finally { conversationDeleting = false; conversationCleanupJob = false; settings.update(); startConversationDates(); }
  };
  register('agentTandem.scanConversationCleanup', () => conversationCleanupAction(async () => { conversationCleanup.cancel(); return conversationCleanup.inspect(); }));
  register('agentTandem.previewConversationCleanup', value => conversationCleanupAction(() => conversationCleanup.preview((value as { keys?: unknown } | undefined)?.keys)));
  register('agentTandem.deleteConversations', async value => {
    // Clicking Delete selected/all matching authorizes the selected keys or the filters, with their date cutoff.
    const request = value as { token?: unknown; keys?: unknown; before?: unknown; filter?: unknown } | undefined;
    const progress: DeletionProgress = {
      signal: conversationCleanupDisposed.signal,
      dates: dates => { conversationCleanupState = { ...conversationCleanupState, dates }; settings.update(); },
      deleting: (done, total) => { conversationCleanupState = { ...conversationCleanupState, dates: undefined, done, total }; settings.update(); }
    };
    await conversationCleanupAction(() => withStorageLock(storage.root, () => request?.filter !== undefined
      ? conversationCleanup.deleteMatching(request.filter, progress)
      : request?.keys !== undefined
        ? conversationCleanup.deleteSelected(request.keys, request.before, progress)
        : conversationCleanup.delete(request?.token, progress.deleting)), true);
    const deleted = conversationCleanupState.result;
    if (deleted) await recordFreed({ bytes: deleted.bytes, conversations: deleted.removed.length });
    await syncConversations().catch(report);
    await vscode.commands.executeCommand('agentTandem.refreshUsageDashboard');
  });
  // Each update posts the whole dashboard state, so per-file ticks are throttled; phase changes and the last file always render.
  let storageProgressAt = 0;
  const storageProgress = (progress: StorageProgress) => {
    storageState = { ...storageState, progress };
    if (progress.phase === 'removing' && progress.done && progress.done < progress.total && Date.now() - storageProgressAt < 200) return;
    storageProgressAt = Date.now(); settings.update();
  };
  register('agentTandem.refreshStorage', () => storageAction(async () => { cleanupPlan = undefined; historyDeletionPlan = undefined; return storage.inspect(); }));
  register('agentTandem.previewStorageCleanup', () => storageAction(async () => {
    historyDeletionPlan = undefined;
    const summary = await storage.inspect();
    if (summary.cleanupBlocked) throw new Error(summary.cleanupBlocked);
    cleanupPlan = await storage.preview(); return { ...summary, plan: cleanupPlan };
  }));
  register('agentTandem.previewHistoryDeletion', value => storageAction(async () => {
    if (!value || typeof value !== 'object' || !Array.isArray((value as { ids?: unknown }).ids)) throw new Error('Select saved history to delete.');
    cleanupPlan = undefined;
    const summary = await storage.inspect();
    if (summary.cleanupBlocked) throw new Error(summary.cleanupBlocked);
    historyDeletionPlan = await storage.previewHistoryDeletion((value as { ids: string[] }).ids);
    return { ...summary, historyPlan: historyDeletionPlan };
  }));
  register('agentTandem.previewCleanAll', value => storageAction(async () => {
    cleanupPlan = undefined;
    const summary = await storage.inspect();
    if (summary.cleanupBlocked) throw new Error(summary.cleanupBlocked);
    historyDeletionPlan = await storage.previewKindCleanup((value as { kinds?: unknown } | undefined)?.kinds);
    return { ...summary, historyPlan: historyDeletionPlan };
  }));
  register('agentTandem.previewReviewCleanup', async value => {
    const scope = (value as { scope?: unknown } | undefined)?.scope;
    if (scope !== 'accepted' && scope !== 'all' && scope !== 'discard') throw new Error('Choose accepted snapshots or all review history.');
    await settings.open('storage', 'restore');
    return storageAction(async () => {
      cleanupPlan = undefined; historyDeletionPlan = undefined;
      const summary = await storage.inspect();
      if (summary.cleanupBlocked) throw new Error(summary.cleanupBlocked);
      historyDeletionPlan = await storage.previewReviewCleanup(scope);
      return { ...summary, historyPlan: historyDeletionPlan };
    });
  });
  register('agentTandem.deleteHistory', value => storageAction(async () => {
    if (!historyDeletionPlan || !value || typeof value !== 'object' || (value as { token?: unknown }).token !== historyDeletionPlan.token) throw new Error('Preview history deletion before deleting data.');
    if (chatAbort || reviewing || externalSwitching || state.running || externalJob || activeReviewProjects.size) throw new Error('Wait for capture or review to finish before deleting history.');
    const approved = historyDeletionPlan;
    // The inline preview names the restore points lost and exact files freed.
    // Its Delete history button is the explicit confirmation; do not ask twice.
    storageState = { ...storageState, status: 'cleaning' }; settings.update();
    const result = await storage.deleteHistory(approved, storageProgress); historyDeletionPlan = undefined;
    await recordFreed({ bytes: result.bytes, files: result.removed });
    storageProgress({ phase: 'refreshing', done: approved.files.length, total: approved.files.length, bytes: result.bytes, totalBytes: approved.bytes });
    state.checkpointPreview = undefined; checkpointPlan = undefined;
    const project = state.project, conversation = state.conversation;
    if (project) {
      const [saved, undo] = await Promise.all([conversation ? checkpoints.list(project, conversation) : Promise.resolve([]), checkpoints.undo(project)]);
      if (state.project === project && state.conversation === conversation) { state.checkpoints = saved; state.checkpointUndo = undo; }
      // Stopped tracking must also stop the external watcher and show Review's notice.
      if (result.trackingStopped) await refreshReview(project).catch(report);
    }
    update();
    return { ...(await storage.inspect()), historyResult: result };
  }));
  register('agentTandem.cleanupStorage', value => storageAction(async () => {
    if (!cleanupPlan || !value || typeof value !== 'object' || (value as { token?: unknown }).token !== cleanupPlan.token) throw new Error('Preview cleanup before deleting data.');
    if (chatAbort || reviewing || externalSwitching || state.running || externalJob) throw new Error('Wait for capture or review to finish before cleanup.');
    const approved = cleanupPlan;
    if (!approved.files.length) return { ...(await storage.inspect()), plan: approved };
    const answer = await vscode.window.showWarningMessage(`Remove ${approved.files.length} unused snapshot files (${(approved.bytes / 1024 / 1024).toFixed(2)} MB) from AgentTandem storage?`, { modal: true, detail: `Only the files in your preview are eligible. Baselines, pending review, checkpoints, Undo and demo history stay protected. Project files, native Codex/Claude history, attachments and usage records are kept.\n\n${storage.root}` }, 'Clean unused snapshots');
    if (answer !== 'Clean unused snapshots') return { ...(await storage.inspect()), plan: approved };
    storageState = { ...storageState, status: 'cleaning' }; settings.update();
    const result = await storage.cleanup(approved, storageProgress); cleanupPlan = undefined;
    await recordFreed({ bytes: result.bytes, files: result.removed });
    storageProgress({ phase: 'refreshing', done: approved.files.length, total: approved.files.length, bytes: result.bytes, totalBytes: approved.bytes });
    return { ...(await storage.inspect()), result };
  }));
  register('agentTandem.revealStorage', () => vscode.commands.executeCommand('revealFileInOS', context.globalStorageUri));
  const onboardingMarker = vscode.Uri.joinPath(context.globalStorageUri, 'onboarding-v1.done');
  const showGettingStarted = async () => {
    await vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#gettingStarted`, false);
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    await vscode.workspace.fs.writeFile(onboardingMarker, new Uint8Array([49]));
  };
  register('agentTandem.gettingStarted', showGettingStarted);
  register('agentTandem.trackingControls', async () => {
    const project = state.project, version = generation;
    const enabled = !!state.review?.externalTracking;
    const choices = [
      { label: '$(diff) Review changes', description: `${state.review?.files.length ?? 0} files pending`, action: 'review' },
      { label: enabled ? '$(debug-pause) Pause tracking' : '$(eye) Resume tracking', description: 'Remember this choice for this workspace', action: 'toggle' },
      { label: '$(refresh) Capture changes now', description: 'Refresh saved workspace edits', action: 'capture' },
      { label: '$(book) Getting started', description: 'Tracking, review, chat and usage dashboard', action: 'guide' },
    ];
    const choice = await vscode.window.showQuickPick(choices, { title: `AgentTandem · Change tracking ${enabled ? 'on' : 'off'}`, placeHolder: 'Saved changes from all apps are tracked, including manual edits.' });
    if (!choice) return;
    if (choice.action === 'guide') return showGettingStarted();
    if (disposed || version !== generation || project !== state.project) throw new Error('The workspace changed. Open change tracking again.');
    if (choice.action === 'toggle') return vscode.commands.executeCommand('agentTandem.toggleExternalReview');
    if (choice.action === 'capture') return captureExternalReview();
    state.screen = 'changes'; update(); await preview.open(); await captureExternalReview();
  });
  register('agentTandem.toggleExternalReview', async () => {
    const project = state.project, version = generation;
    if (!project || !vscode.workspace.isTrusted) throw new Error('Open and trust a local workspace before tracking external changes.');
    if (chatAbort || reviewing || externalSwitching) throw new Error('Wait for the active action before changing external review mode.');
    const enabled = !state.review?.externalTracking;
    externalSwitching = true; state.reviewBusy = true; update();
    try {
      if (externalJob) await externalJob;
      if (disposed || generation !== version || state.project !== project) throw new Error('The workspace changed. Toggle external review again.');
      const result = await reviews.setExternalTracking(project, enabled);
      if (!disposed && generation === version && state.project === project) { state.review = result; configureExternalWatcher(project, !!result.externalTracking); }
      return result;
    } finally { externalSwitching = false; if (!disposed && generation === version && state.project === project) { state.reviewBusy = false; update(); } }
  });
  register('agentTandem.captureExternalChanges', async () => { await captureExternalReview(); return state.review; });

  register('agentTandem.openSettings', async () => { settings.open(); await refreshAccounts(); return dashboardState(); });
  register('agentTandem.quickAccounts', async provider => { await quickAccounts.show(isAccountProvider(provider) ? provider : undefined); });
  register('agentTandem.quickSwitchAccount', async id => {
    const profile = dashboardState().managedAccounts?.find(row => row.id === id);
    if (!profile || profile.active) return;
    await accountManager.action({ action: 'switch', id: profile.id });
  });
  register('agentTandem.resetCodexUsage', async () => { await accountManager.action({ action: 'resetUsage', provider: 'Codex' }); });
  // Saved accounts must not wait behind storage measurement or the usage-history scan.
  register('agentTandem.refreshQuotaAccounts', async () => {
    await Promise.all([refreshStorageUsage(true), refreshUsageDashboard(), (async () => {
      await Promise.all([loadAccount('Codex', true), loadAccount('Claude', true)]);
      await accountManager.refresh(); await recordQuotaHistory();
    })()]);
  });
  register('agentTandem.openExtensionStorage', async () => { settings.open('storage', 'unused'); await vscode.commands.executeCommand('agentTandem.refreshStorage'); return dashboardState(); });
  register('agentTandem.manageAccounts', async () => { settings.open('accounts'); await accountManager.refresh(); return dashboardState(); });
  register('agentTandem.accountAction', async value => { await accountManager.action(value); return dashboardState(); });
  register('agentTandem.openStorage', async () => { settings.open('storage'); await vscode.commands.executeCommand('agentTandem.refreshStorage'); return dashboardState(); });
  register('agentTandem.refreshUsageDashboard', async () => {
    await Promise.all([loadAccount('Codex', true), loadAccount('Claude', true)]); await recordQuotaHistory(); await refreshUsageDashboard(); return dashboardState();
  });
  register('agentTandem.openVSCodeSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`));
  register('agentTandem.usageAttribution', async value => {
    if (attributionBusy) throw new Error('Wait for the history assignment to finish.');
    attributionBusy = true; attributionError = undefined; attributionNotice = undefined; settings.update();
    try {
      if (!value || typeof value !== 'object') throw new Error('Invalid history assignment request.');
      const request = value as { action?: string; id?: string; scope?: UsageAssignmentScope; accountId?: string | null };
      if (request.action === 'remove' && typeof request.id === 'string') await attributionStore.remove(request.id);
      else if (request.action === 'assign' && request.scope && validAssignmentScope(request.scope)) {
        const scope = request.scope;
        if (scope.conversationId && !usageState.data?.conversations?.some(row => row.provider === scope.provider && row.id === scope.conversationId)) throw new Error('This conversation no longer exists. Refresh the dashboard.');
        const known = await knownUsageAccounts(accountProfiles, state.accounts);
        const available = [...known.map(row => row.account), ...(usageState.data?.days.flatMap(row => row.account ? [row.account] : []) ?? [])];
        const account = request.accountId === null ? null : available.find(row => row.provider === scope.provider && row.id === request.accountId);
        if (account === undefined) throw new Error('Choose an available account for this provider.');
        await attributionStore.assign(scope, account);
      } else throw new Error('Choose a conversation or a valid date range.');
      if (usageJob) await usageJob;
      await refreshUsageDashboard();
      attributionNotice = request.action === 'remove' ? 'Assignment removed. Automatic matching is restored.' : 'History assignment saved. Native turn evidence takes priority.';
    } catch (error) { attributionError = error instanceof Error ? error.message : 'Could not save history assignment.'; }
    finally { attributionBusy = false; settings.update(); }
  });
  register('agentTandem.setDashboardPreferences', async value => {
    if (!value || typeof value !== 'object') throw new Error('Invalid dashboard preference.');
    const selection = value as Record<string, unknown>, config = vscode.workspace.getConfiguration('agentTandem');
    if (selection.showQuotaInStatusBar !== undefined && typeof selection.showQuotaInStatusBar !== 'boolean') throw new Error('Invalid status bar preference.');
    if (selection.grouping !== undefined && !['day', 'week', 'month'].includes(String(selection.grouping))) throw new Error('Invalid dashboard grouping.');
    const statusChanges = selection.statusBar !== undefined ? statusBarPreferenceChanges(selection.statusBar) : [];
    if (selection.showQuotaInStatusBar !== undefined) await config.update('showQuotaInStatusBar', selection.showQuotaInStatusBar, vscode.ConfigurationTarget.Global);
    if (selection.grouping !== undefined) await config.update('usageDashboardDefaultGrouping', selection.grouping, vscode.ConfigurationTarget.Global);
    for (const change of statusChanges) await config.update(change.key, change.value, vscode.ConfigurationTarget.Global);
    update();
  });
  register('agentTandem.manageCLIs', async () => { state.screen = 'cli'; update(); await refreshCLIManager(); await preview.open(); });
  register('agentTandem.refreshCLIs', () => { cliResolver.invalidate(); return refreshCLIManager(); });
  register('agentTandem.chooseCLI', async value => {
    if (value !== 'Codex' && value !== 'Claude') throw new Error('Choose a provider.');
    if (!state.project || !vscode.workspace.isTrusted) throw new Error('Open and trust a local project before choosing its CLI.');
    if (chatAbort || reviewing || cliManaging) throw new Error('Stop the active agent before changing its CLI.');
    const project = state.project, provider = value, registry = await ensureCLIRegistry();
    const selection = await vscode.window.showQuickPick([
      { label: 'Use default CLI', description: 'Use the default from Manage CLIs', id: '' },
      { label: 'Terminal CLI (PATH)', description: 'Use the terminal CLI if it is enabled', id: 'path' },
      ...registry.entries.filter(entry => entry.provider === provider && entry.enabled && !entry.error).map(entry => ({ label: entry.name, description: entry.version, detail: entry.executable, id: entry.id })),
      { label: 'Manage CLIs…', description: 'Add, edit, enable or remove CLI installations', id: 'manage' },
    ], { title: `${provider} CLI for this project`, matchOnDescription: true, matchOnDetail: true });
    if (!selection) return;
    if (selection.id === 'manage') { state.screen = 'cli'; update(); await refreshCLIManager(); return; }
    if (project !== state.project || chatAbort || reviewing || cliManaging) throw new Error('The workspace or agent changed. Choose the CLI again.');
    cliManaging = true; cliResolver.invalidate();
    try { await setProjectCLI(provider, selection.id); await loadModels(provider, true); void loadAccount(provider, true); }
    finally { cliManaging = false; await refreshCLIManager(); }
  });
  register('agentTandem.cliAction', async value => {
    const request = cliRequest(value);
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before managing local CLIs.');
    if (request.project !== state.project) throw new Error('The workspace changed. Try the CLI action again.');
    if (chatAbort || reviewing || cliManaging) throw new Error('Wait for the active agent or CLI action to finish.');
    cliManaging = true;
    if (state.cliManager) { state.cliManager.busy = true; state.cliManager.error = undefined; } state.error = undefined; update();
    try {
      const registry = await ensureCLIRegistry();
      if (registry.revision !== request.revision) throw new Error('The CLI list changed. Refresh and try again.');
      const entry = registry.entries.find(entry => entry.id === request.id && entry.provider === request.provider);
      if (['edit', 'toggle', 'remove'].includes(request.action) && !entry) throw new Error('Choose an existing CLI entry.');
      const provider = request.provider, name = provider === 'Codex' ? 'codex' : 'claude';
      if (request.action === 'add' || request.action === 'edit') {
        let executable = request.executable;
        if (executable === undefined) {
          const files = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFolders: false, title: `Add ${provider} CLI`, filters: process.platform === 'win32' ? { Executable: ['exe'] } : undefined });
          if (!files?.[0]) return; executable = files[0].fsPath;
        }
        if (!executable.trim()) throw new Error('Enter a CLI executable path.');
        const info = await cliInfo(name, executable);
        if (!(provider === 'Codex' ? /^codex-cli\s+/i.test(info.version) : /Claude Code/i.test(info.version))) throw new Error(`This executable does not identify itself as ${provider}.`);
        const registered = { ...info, provider, name: request.name?.trim() || entry?.name || `${provider} ${info.version.replace(/^codex-cli\s+/, '').replace(/ \(Claude Code\)$/, '')}` };
        if (request.action === 'add') await cliStore.add(request.revision, registered);
        else await cliStore.edit(request.revision, entry!.id, registered);
        if (entry && request.project === state.project && cliPathKey(entry.executable) !== cliPathKey(info.executable) && state.project && vscode.workspace.getConfiguration('agentTandem', vscode.Uri.file(state.project)).get<string>(cliKey(provider)) === entry.executable) {
          await vscode.workspace.getConfiguration('agentTandem', vscode.Uri.file(state.project)).update(cliKey(provider), info.executable, vscode.ConfigurationTarget.WorkspaceFolder);
        }
      } else if (request.action === 'toggle') {
        if (request.enabled === undefined) throw new Error('Choose whether this CLI is enabled.');
        await cliStore.toggle(request.revision, entry!.id, request.enabled);
      } else if (request.action === 'remove') await cliStore.remove(request.revision, entry!.id);
      else if (request.action === 'default') await cliStore.setDefault(request.revision, provider, request.id ?? '');
      else if (request.action === 'use') await setProjectCLI(provider, request.id ?? '');
      else if (request.action === 'scan') await cliStore.scan(request.revision, await discoverCLIs([provider]));
      else if (request.action === 'refresh') {
        const rows = registry.entries.filter(row => row.provider === provider && (!request.id || row.id === request.id));
        const checked = await Promise.all(rows.map(async row => {
          try { const info = await cliInfo(name, row.executable); if (!(provider === 'Codex' ? /^codex-cli\s+/i.test(info.version) : /Claude Code/i.test(info.version))) throw new Error(`This executable is not ${provider}.`); return { id: row.id, version: info.version, error: undefined }; }
          catch (error) { return { id: row.id, version: row.version, error: (error as Error).message }; }
        }));
        await cliStore.mutate(request.revision, registry => { for (const result of checked) Object.assign(registry.entries.find(row => row.id === result.id)!, result); });
      }
      if (request.project !== state.project) return;
      modelJobs.get(provider)?.abort.abort(); modelJobs.delete(provider);
      state.modelCatalogs = { ...state.modelCatalogs, [provider]: undefined };
      accountJobs.get(provider)?.abort.abort(); accountJobs.delete(provider);
      state.accounts = { ...state.accounts, [provider]: undefined }; void loadAccount(provider, true).then(() => refreshUsageDashboard());
      if (state.project) await loadModels(provider, true);
    } catch (error) {
      if (state.cliManager) state.cliManager.error = (error as Error).message;
      throw error;
    } finally { cliResolver.invalidate(); cliManaging = false; await refreshCLIManager(); }
  });
  register('agentTandem.refreshAccount', async value => {
    const selection = value as { project?: string; provider?: ConversationProvider } | undefined;
    if (!selection || selection.project !== state.project || (selection.provider !== 'Codex' && selection.provider !== 'Claude')) throw new Error('The workspace changed. Refresh the account again.');
    await loadAccount(selection.provider, true); await refreshUsageDashboard(); return state.accounts?.[selection.provider];
  });
  register('agentTandem.refreshModels', async value => {
    const selection = modelSelection(value);
    if (selection.project !== state.project) throw new Error('The workspace changed. Refresh models again.');
    if (chatAbort || reviewing) throw new Error('Wait for the active agent before refreshing models.');
    await loadModels(selection.provider, true);
    return state.modelCatalogs?.[selection.provider];
  });
  register('agentTandem.setModel', async value => {
    const selection = modelSelection(value);
    if (!state.project || selection.project !== state.project) throw new Error('The workspace changed. Choose the model again.');
    if (chatAbort || reviewing) throw new Error('Stop the active agent before changing its model.');
    const provider = state.conversation?.conversation.provider ?? state.composeProvider ?? 'Codex';
    if (selection.provider !== provider) throw new Error('The selected provider changed. Choose the model again.');
    validateModel(selection.model, state.modelCatalogs?.[provider]);
    state.selectedModels = { ...(state.selectedModels ?? defaultModels()), [provider]: selection.model }; state.error = undefined; update();
    await modelStore.save(selection.project, provider, selection.model);
  });
  register('agentTandem.setReasoningEffort', async value => {
    const selection = effortSelection(value);
    if (!state.project || selection.project !== state.project) throw new Error('The workspace changed. Choose reasoning effort again.');
    if (chatAbort || reviewing || cliManaging) throw new Error('Wait for the active action before changing reasoning effort.');
    const provider = state.conversation?.conversation.provider ?? state.composeProvider ?? 'Codex';
    if (selection.provider !== provider || selection.model !== (state.selectedModels?.[provider] ?? '')) throw new Error('The selected model changed. Choose reasoning effort again.');
    validateEffort(selection.effort, selection.model, state.modelCatalogs?.[provider]);
    const efforts = state.selectedEfforts ?? defaultEfforts();
    state.selectedEfforts = { ...efforts, [provider]: { ...efforts[provider], [selection.model]: selection.effort } }; state.error = undefined; update();
    await effortStore.save(selection.project, provider, selection.model, selection.effort);
  });
  register('agentTandem.setAccessMode', async value => {
    const selection = accessSelection(value);
    if (!state.project || selection.project !== state.project) throw new Error('The workspace changed. Choose the access mode again.');
    if (chatAbort || reviewing) throw new Error('Stop the active agent before changing its access mode.');
    const provider = state.conversation?.conversation.provider ?? state.composeProvider ?? 'Codex';
    if (selection.provider !== provider) throw new Error('The selected provider changed. Choose the access mode again.');
    state.accessModes = { ...(state.accessModes ?? defaultAccessModes()), [provider]: selection.mode }; state.error = undefined; update();
    await accessStore.save(selection.project, provider, selection.mode);
  });
  register('agentTandem.setFastMode', async value => {
    const selection = fastModeSelection(value);
    if (!state.project || selection.project !== state.project) throw new Error('The workspace changed. Choose Fast mode again.');
    if (chatAbort || reviewing || cliManaging) throw new Error('Wait for the active action before changing Fast mode.');
    const provider = state.conversation?.conversation.provider ?? state.composeProvider ?? 'Codex';
    if (provider !== 'Codex') throw new Error('Fast mode is only supported for Codex.');
    fastModeRevision++; state.codexFastMode = selection.enabled; state.error = undefined; update();
    await fastModeStore.save(selection.project, selection.enabled);
  });
  register('agentTandem.newChat', async provider => {
    if (state.chat?.status === 'running' || chatAbort || reviewing || cliManaging) throw new Error('Wait for the active reply, review or CLI action before starting a new conversation.');
    if (provider !== 'Claude' && provider !== 'Codex') throw new Error('Choose Claude Code or Codex.');
    if (state.project) { chatQueue.pause(state.project, 'New conversation opened. Resume the queued conversation when ready.'); saveQueue(); }
    selectionGeneration++; uiGeneration++; composingNew = true; selectedConversationKey = undefined;
    state.conversation = undefined; liveConversation = undefined; state.chat = undefined;
    state.checkpoints = []; state.checkpointPreview = undefined; checkpointPlan = undefined;
    state.composeProvider = provider; state.screen = 'conversations'; state.error = undefined;
    await preferences.save({ project: state.project }); update(); void loadModels(provider);
  });
  register('agentTandem.stopChat', () => {
    if (!chatAbort || chatAbort.signal.aborted || state.chat?.phase === 'finishing') return;
    if (state.chat) { state.chat.phase = 'stopping'; state.chat.activity = undefined; }
    if (state.project) { chatQueue.pause(state.project, 'Stopped. Resume queued messages when ready.'); saveQueue(); }
    chatAbort.abort(); update();
  });
  register('agentTandem.answerAgent', value => {
    const answer = promptAnswer(value);
    const reply = promptReplies.get(answer.id); if (!reply) throw new Error('This request has already closed.');
    reply(answer);
  });
  register('agentTandem.queueAction', async value => {
    const request = value as { project?: string; action?: string; id?: string; text?: string } | undefined;
    if (!state.project || request?.project !== state.project) throw new Error('The workspace changed. Try again.');
    if (request.action === 'remove' && typeof request.id === 'string') chatQueue.remove(state.project, request.id);
    else if (request.action === 'edit' && typeof request.id === 'string' && typeof request.text === 'string') chatQueue.edit(state.project, request.id, request.text);
    else if (request.action === 'pause') chatQueue.pause(state.project, 'Paused. Resume when ready.');
    else if (request.action === 'resume') {
      const project = state.project, queue = chatQueue.state(project);
      if (!queue) return;
      if (chatAbort || reviewing || cliManaging) throw new Error('Wait for the active action before resuming the queue.');
      if (state.conversation?.conversation.key !== queue.conversationKey) await openConversation(queue.conversationKey);
      if (state.project !== project || chatAbort || reviewing || cliManaging) throw new Error('The workspace or active action changed. Resume again.');
      chatQueue.resume(project); await saveQueue(); drainQueue(project); return;
    } else throw new Error('Choose a queue action.');
    await saveQueue();
  });
  function drainQueue(project: string) {
    if (disposed || state.project !== project || chatAbort || reviewing || cliManaging) return;
    const request = chatQueue.next(project, state.conversation?.conversation); saveQueue();
    if (request) void sendChat(request).catch(error => { chatQueue.restore(request, error instanceof Error ? error.message : 'Could not send. Resume to retry.'); saveQueue(); report(error); });
  }
  register('agentTandem.sendChat', sendChat);
  async function sendChat(value: unknown) {
    if (accountManager.state.accountsBusy) throw new Error('Wait for the account operation to finish before starting a turn.');
    const request = chatRequest(value);
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before chatting with an agent.');
    if (!state.project || request.project !== state.project) throw new Error('The workspace changed. Send your message again.');
    if (chatAbort && state.chat && state.chat.phase !== 'stopping') {
      chatQueue.enqueue(request, state.chat, state.conversation?.conversation.key); state.error = undefined; await saveQueue(); return;
    }
    if (state.chat?.status === 'running' || chatAbort || reviewing || cliManaging) throw new Error('Wait for the active agent, change review or CLI action to finish.');
    if (conversationCleanupState.status === 'cleaning') throw new Error('Wait for conversation cleanup to finish before starting an agent.');
    const dirty = vscode.workspace.textDocuments.find(document => document.isDirty && document.uri.scheme === 'file' && belongsToProject(path.dirname(document.uri.fsPath), state.project!));
    if (dirty) throw new Error(`Save ${path.basename(dirty.uri.fsPath)} before sending so its current contents can be reviewed and reverted.`);
    const selected = state.conversation?.conversation;
    if (request.conversationKey && (selected?.key !== request.conversationKey || selected.provider !== request.provider || !source.belongs(selected.cwd, state.project))) throw new Error('The selected conversation changed. Send your message again.');
    if (!request.conversationKey && selected?.id) throw new Error('Start a new chat before changing agents.');
    const edit = request.edit ? editChat(request, state.conversation!) : undefined;
    const mode = accessMode(request.accessMode ?? state.accessModes?.[request.provider], request.provider);
    const model = validateModel(request.model ?? state.selectedModels?.[request.provider] ?? '', state.modelCatalogs?.[request.provider]);
    const reasoningEffort = validateEffort(request.reasoningEffort ?? state.selectedEfforts?.[request.provider]?.[model] ?? '', model, state.modelCatalogs?.[request.provider]);
    const speed = request.provider === 'Codex' ? { fastMode: request.fastMode ?? state.codexFastMode ?? false } : {};
    const requestedCatalog = state.modelCatalogs?.[request.provider];
    const providerRequest: ProviderChatRequest = { ...request, model, reasoningEffort, ...speed, accessMode: mode, ...(edit ? { fork: edit.fork } : {}) };
    const version = generation, abort = new AbortController(); chatAbort = abort;
    const chatTitle = request.text.replace(/\s+/g, ' ').slice(0, 140) || request.attachments?.map(item => item.name).join(', ').slice(0, 140) || 'Attachments';
    const content: ConversationContent = request.conversationKey ? structuredClone(state.conversation!) : {
      conversation: { key: `${request.provider}:draft-${request.requestId}`, id: '', provider: request.provider, title: chatTitle, cwd: state.project, updatedAt: Date.now(), revision: 'live:0' }, messages: [],
    };
    const originalContent = edit ? structuredClone(content) : undefined;
    content.notice = undefined;
    if (edit) {
      content.usage = undefined;
      content.messages = structuredClone(edit.messages);
      content.conversation = { ...content.conversation, id: '', key: `${request.provider}:draft-${request.requestId}`, title: chatTitle, revision: `live:${request.requestId}` };
      content.notice = 'Edited message · new conversation branch. Current project changes remain applied.';
    }
    content.messages.push({ id: request.requestId, role: 'user', text: request.text, ...(request.attachments?.length ? { attachments: request.attachments } : {}) });
    const draftCheckpointKey = content.conversation.key;
    let checkpointRecorded = false, checkpointBinding: Promise<void> = Promise.resolve();
    state.checkpoints = []; state.checkpointPreview = undefined; checkpointPlan = undefined;
    liveConversation = content; state.conversation = content; composingNew = false; selectionGeneration++;
    state.accessModes = { ...(state.accessModes ?? defaultAccessModes()), [request.provider]: mode };
    state.selectedModels = { ...(state.selectedModels ?? defaultModels()), [request.provider]: model };
    const efforts = state.selectedEfforts ?? defaultEfforts();
    state.selectedEfforts = { ...efforts, [request.provider]: { ...efforts[request.provider], [model]: reasoningEffort } };
    if (request.provider === 'Codex') { fastModeRevision++; state.codexFastMode = speed.fastMode; }
    state.chat = { requestId: request.requestId, provider: request.provider, model, reasoningEffort, ...speed, accessMode: mode, status: 'running', phase: 'preparing', conversationKey: content.conversation.key, prompts: [] };
    state.screen = 'conversations'; state.error = undefined; update();
    const current = () => !disposed && version === generation && state.chat?.requestId === request.requestId;
    const activeTools = new Map<string, string>();
    const callbacks: ChatCallbacks = {
      attributeUsage: (key, account) => { void usageAccounts.record(key, account).catch(report); },
      usage: usage => {
        if (!current() || abort.signal.aborted) return;
        content.usage = { ...usage, selectedModel: model }; update();
      },
      activity: (id, label) => {
        if (!current() || abort.signal.aborted) return;
        if (label) activeTools.set(id, label); else activeTools.delete(id);
        const activity = [...activeTools.values()].at(-1);
        if (state.chat!.activity !== activity) { state.chat!.activity = activity; update(); }
      },
      session: id => {
        if (!current() || !id || content.conversation.id === id) return;
        const previousKey = content.conversation.key;
        content.conversation.id = id; content.conversation.key = `${request.provider}:${id}`;
        const boundConversation = { key: content.conversation.key, id, provider: request.provider, title: content.conversation.title };
        checkpointBinding = checkpointBinding.then(() => reviews.bindConversation(request.project, previousKey, boundConversation)).then(() => undefined).catch(report);
        chatQueue.bind(request.project, previousKey, content.conversation.key); saveQueue();
        if (checkpointRecorded) {
          const key = content.conversation.key;
          checkpointBinding = checkpointBinding.then(() => checkpoints.bind(request.project, draftCheckpointKey, key)).then(async () => {
            const saved = await checkpoints.list(request.project, content);
            if (current() && state.conversation === content) { state.checkpoints = saved; update(); }
          }).catch(report);
        }
        state.chat!.conversationKey = content.conversation.key; selectedConversationKey = content.conversation.key;
        if (!state.conversations?.some(item => item.key === content.conversation.key)) state.conversations?.unshift(content.conversation);
        void preferences.save({ project: request.project, conversation: content.conversation.key }).catch(report); update();
      },
      message: (message, append) => {
        if (!current() || abort.signal.aborted) return;
        const previous = content.messages.find(item => item.id === message.id);
        if (previous) Object.assign(previous, message, { text: append ? previous.text + message.text : message.text }); else content.messages.push(message);
        content.conversation.revision = `live:${Date.now()}:${randomUUID()}`; content.conversation.updatedAt = Date.now(); update();
      },
      prompt: (prompt, signal) => new Promise(resolve => {
        const id = randomUUID();
        if (!current() || signal.aborted || abort.signal.aborted) { resolve({ id, allow: false }); return; }
        const finish = (answer: PromptAnswer) => {
          if (prompt.questions && !signal.aborted && !abort.signal.aborted) questionAnswers(prompt.questions, answer);
          if (answer.allowScope && !prompt.allowOptions?.some(option => option.scope === answer.allowScope)) throw new Error('This permission choice is not available for the current request.');
          promptReplies.delete(id); signal.removeEventListener('abort', stop); abort.signal.removeEventListener('abort', stop);
          if (current()) { state.chat!.prompts = state.chat!.prompts.filter(p => p.id !== id); update(); }
          resolve(answer);
        };
        const stop = () => finish({ id, allow: false });
        promptReplies.set(id, finish); signal.addEventListener('abort', stop, { once: true }); abort.signal.addEventListener('abort', stop, { once: true });
        state.chat!.prompts.push({ ...prompt, id }); update();
      }),
    };
    try {
      const config = vscode.workspace.getConfiguration('agentTandem', vscode.Uri.file(request.project));
      providerRequest.preparedAttachments = await attachments.prepare(request.attachments);
      // Checkpoints and immediate edit/resend must match the native history text.
      if (request.attachments?.length) {
        const user = content.messages.find(message => message.id === request.requestId);
        if (user && request.provider === 'Claude') user.text = claudeMessages([{ uuid: request.requestId, type: 'user', message: { content: claudeContent(providerRequest) } }])[0]?.text ?? request.text;
        else if (user && !request.text && request.attachments.every(item => item.mimeType.startsWith('image/'))) user.text = '[Image]';
      }
      const selectedCLI = await managedCLI(request.provider, request.project, abort.signal);
      const cli = selectedCLI.cli;
      validateModelCLI(model || reasoningEffort, requestedCatalog, cli);
      await Promise.all([accessStore.save(request.project, request.provider, mode), modelStore.save(request.project, request.provider, model), effortStore.save(request.project, request.provider, model, reasoningEffort), ...(speed.fastMode !== undefined ? [fastModeStore.save(request.project, speed.fastMode)] : [])]);
      activeReviewProjects.add(request.project);
      const review = await reviews.begin(request.project, request.requestId, abort.signal, { key: content.conversation.key, id: content.conversation.id, provider: request.provider, title: content.conversation.title });
      await checkpoints.record(request.project, draftCheckpointKey, content.messages.filter(message => message.role === 'user').map(message => message.text), await reviews.checkpointBefore(request.project, request.requestId), originalContent?.conversation.key, content.conversation.title);
      checkpointRecorded = true;
      const savedCheckpoints = await checkpoints.list(request.project, content);
      if (current() && state.conversation === content) state.checkpoints = savedCheckpoints;
      if (current()) { state.review = review; update(); }
      if (abort.signal.aborted) { if (current()) state.chat!.status = 'interrupted'; return; }
      if (current()) { state.chat!.phase = 'working'; update(); }
      let result;
      if (request.provider === 'Codex') result = await runCodexChat(providerRequest, callbacks, abort.signal, cli.executable);
      else {
        const sdk = await nativeImport(pathToFileURL(path.join(context.extensionUri.fsPath, 'dist/claude-history.mjs')).href) as ClaudeHistoryAPI & typeof import('./providers/claude-history');
        result = await runClaudeChat(providerRequest, callbacks, abort, sdk.query, cli.executable, sdk,
          content.usage?.selectedModel === model ? content.usage : undefined);
      }
      if (current()) state.chat!.status = result;
    } catch (error) {
      if (!abort.signal.aborted) cliResolver.invalidateOnFailure(request.provider, error);
      if (current()) { state.chat!.status = abort.signal.aborted ? 'interrupted' : 'failed'; if (!abort.signal.aborted) report(error); }
    } finally {
      abort.abort();
      try {
        if (current()) { state.chat!.phase = 'finishing'; state.chat!.activity = undefined; update(); }
        try {
          await checkpointBinding;
          const review = await reviews.finish(request.project, request.requestId);
          if (!disposed && state.project === request.project) { state.review = review; state.reviewPreview = undefined; update(); }
        } catch (error) {
          if (current()) state.chat!.status = 'failed';
          if (!disposed && state.project === request.project) report(error);
        } finally { activeReviewProjects.delete(request.project); }
        if (request.project === state.project && !disposed) void loadAccount(request.provider, true);
        await checkpointBinding;
        if (current() && originalContent && !content.conversation.id) {
          liveConversation = originalContent; state.conversation = originalContent;
          state.checkpoints = await checkpoints.list(request.project, originalContent);
          selectedConversationKey = originalContent.conversation.key; state.chat!.conversationKey = originalContent.conversation.key;
        }
        if (current()) { state.chat!.prompts = []; state.chat!.activity = undefined; update(); await syncConversations().catch(report); }
        if (content.usage && content.conversation.id) {
          const fresh = state.project === request.project ? state.conversations?.find(row => row.key === content.conversation.key) : undefined;
          // Store after the CLI has flushed history. Revision matching prevents
          // later external CLI activity from restoring stale context/cache data.
          await contextStore.save(content.conversation.cwd, content.conversation.key, content.usage, fresh?.revision).catch(report);
          if (current() && state.conversation?.conversation.key === content.conversation.key) { state.conversation.usage = content.usage; update(); }
        }
      } catch (error) {
        if (current()) { state.chat!.status = 'failed'; report(error); }
      } finally {
        if (chatAbort === abort) chatAbort = undefined;
        if (current()) {
          state.chat!.phase = undefined;
          if (state.chat?.status !== 'completed') chatQueue.pause(request.project, state.chat?.status === 'interrupted' ? 'Stopped. Resume queued messages when ready.' : 'Agent failed. Resume queued messages when ready.');
          await saveQueue(); drainQueue(request.project);
        }
      }
    }
  }
  function reviewRequest(value: unknown): ReviewRequest {
    if (!value || typeof value !== 'object') throw new Error('Choose a pending change.');
    const request = value as ReviewRequest;
    if (request.project !== state.project || typeof request.revision !== 'string' || (request.file !== undefined && typeof request.file !== 'string') || (request.group !== undefined && (typeof request.group !== 'string' || !request.group))) throw new Error('The project or review changed.');
    return request;
  }
  register('agentTandem.previewReview', async value => {
    const request = reviewRequest(value), version = ++uiGeneration;
    const current = () => !disposed && request.project === state.project && version === uiGeneration;
    if (vscode.workspace.getConfiguration('agentTandem').get<string>('reviewEditor', 'webview') === 'native') await openReviewChanges(reviews, request, changeNavigation, current);
    else await reviewEditor!.open(request, current);
  });
  register('agentTandem.closeReviewPreview', () => { state.reviewPreview = undefined; update(); });
  const setReviewConversation = async (value: unknown, remove = false) => {
    const request = reviewRequest(value), version = generation;
    const ready = () => {
      if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before linking changes.');
      if (disposed || version !== generation || request.project !== state.project || request.revision !== state.review?.revision) throw new Error('The project or review changed. Choose the current changes again.');
      if (chatAbort || reviewing || externalJob || externalSwitching) throw new Error('Wait for the agent and change capture to finish.');
    };
    await settleExternalCapture(); ready();
    const files = await reviews.editorFiles(request);
    let conversation;
    if (!remove) {
      const index = await source.list(request.project), key = (value as { conversationKey?: unknown }).conversationKey;
      if (key !== undefined && typeof key !== 'string') throw new Error('Choose a saved conversation.');
      if (key !== undefined) {
        conversation = index.conversations.find(item => item.key === key);
        if (!conversation) throw new Error('This conversation is not available in the current workspace.');
      } else {
        const selected = await vscode.window.showQuickPick(index.conversations.map(item => ({ label: item.title, description: item.provider, detail: item.id, conversation: item })), {
          title: `Link ${files.length} ${files.length === 1 ? 'file' : 'files'} to a conversation`,
          placeHolder: index.conversations.length ? 'Choose the conversation that produced these changes' : 'No saved conversations in this workspace. Sync conversations and try again.', matchOnDescription: true,
        });
        if (!selected) return;
        conversation = selected.conversation;
      }
    }
    await settleExternalCapture(); ready();
    reviewing = true; state.reviewBusy = true; state.error = undefined; update();
    try {
      const result = await reviews.setConversationLink(request, conversation);
      if (disposed || version !== generation || request.project !== state.project) return;
      state.review = result; state.reviewPreview = undefined; state.revertPreview = undefined;
      await changeNavigation.refreshReview(request.project, result.files.map(file => ({ file: file.path, original: reviewSnapshotUri(file.before, file.path), modified: reviewSnapshotUri(file.after, file.path), review: { project: request.project, revision: result.revision, group: reviewGroup(file) } })));
    } finally { reviewing = false; if (!disposed && version === generation && request.project === state.project) { state.reviewBusy = false; update(); } }
  };
  register('agentTandem.linkReviewConversation', value => setReviewConversation(value));
  register('agentTandem.unlinkReviewConversation', value => setReviewConversation(value, true));
  register('agentTandem.refreshReview', async () => { if (state.review?.externalTracking) await captureExternalReview(true); else await refreshReview(state.project, true); });
  register('agentTandem.reviewLatest', async () => {
    followRoot();
    const project = state.project;
    if (project && !state.review) await refreshReview(project, true);
    if (state.review?.externalTracking && !chatAbort && !reviewing && !externalSwitching) await captureExternalReview();
    if (project !== state.project) return;
    const review = state.review;
    if (!project || !review?.files.length) { state.screen = 'changes'; update(); await preview.open(); return; }
    const latest = [...review.files].sort((a, b) => Math.max(0, ...(b.captures ?? []).map(capture => capture.to)) - Math.max(0, ...(a.captures ?? []).map(capture => capture.to)))[0]!;
    await vscode.commands.executeCommand('agentTandem.previewReview', { project, revision: review.revision, file: latest.path });
  });
  const previewRevert = async (value: unknown) => {
    const request = reviewRequest(value), project = state.project;
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before reviewing agent changes.');
    await settleExternalCapture();
    if (chatAbort || reviewing || externalJob || externalSwitching) throw new Error('Wait for the agent and change capture to finish.');
    const hunk = (value as Partial<ReviewHunkRequest>).hunk;
    if (hunk !== undefined && (typeof hunk !== 'string' || !request.file || !(await reviews.hunks(request)).some(item => item.id === hunk))) throw new Error('This change is stale. Review the updated preview.');
    const files = await reviews.editorFiles(request);
    if (disposed || project !== state.project) return;
    state.revertPreview = { token: randomUUID(), request: { ...request }, hunk, files };
    state.screen = 'changes'; state.error = undefined; update(); await preview.open();
  };
  register('agentTandem.previewRevert', previewRevert);
  register('agentTandem.cancelRevert', () => { state.revertPreview = undefined; update(); });
  const decideReview = async (value: unknown, revert: boolean) => {
    const request = reviewRequest(value);
    const hunk = (value as Partial<ReviewHunkRequest>).hunk;
    if (hunk !== undefined && (typeof hunk !== 'string' || !request.file)) throw new Error('Choose a change to review.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before reviewing agent changes.');
    await settleExternalCapture();
    if (chatAbort || reviewing || externalJob || externalSwitching) throw new Error('Wait for the agent and change capture to finish.');
    if (revert || hunk !== undefined) {
      const targets = state.review?.files.filter(file => (!request.file || file.path === request.file) && (!request.group || reviewGroup(file) === request.group)) ?? [];
      const dirty = vscode.workspace.textDocuments.find(document => document.isDirty && targets.some(file => vscode.Uri.joinPath(vscode.Uri.file(request.project), file.path).toString().toLowerCase() === document.uri.toString().toLowerCase()));
      if (dirty) throw new Error(`Cannot revert ${path.basename(dirty.uri.fsPath)} while it has unsaved edits. Your edits were kept.`);
    }
    reviewing = true; state.reviewBusy = true; state.error = undefined; update();
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const comparison = changeNavigation.comparison();
    const anchor = (value as { line?: number }).line;
    const line = Number.isInteger(anchor) && anchor! >= 0 ? anchor! : vscode.window.activeTextEditor?.selection.active.line ?? 0;
    const fileIndex = state.review?.files.findIndex(file => file.path === request.file) ?? 0;
    try {
      const result = await (hunk !== undefined
        ? reviews.decideHunk({ ...request, file: request.file!, hunk }, revert)
        : revert ? reviews.revert(request) : reviews.accept(request));
      if (disposed || state.project !== request.project) return;
      state.review = result; state.reviewPreview = undefined; state.revertPreview = undefined;
      const followsReview = comparison?.review?.project === request.project && comparison.review.revision === request.revision;
      const preserve = followsReview && vscode.window.tabGroups.activeTabGroup.activeTab === tab ? tab : undefined;
      const group = request.group ?? comparison?.review?.group;
      const remaining = result.files.filter(file => !group || reviewGroup(file) === group);
      const comparisons = result.files.map(file => ({ file: file.path, original: reviewSnapshotUri(file.before, file.path), modified: reviewSnapshotUri(file.after, file.path), review: { project: request.project, revision: result.revision, group: reviewGroup(file) } }));
      await changeNavigation.refreshReview(request.project, comparisons, preserve);
      let reopened = false;
      if (preserve && !disposed && state.project === request.project && vscode.window.tabGroups.activeTabGroup.activeTab === preserve && remaining.length) {
        const file = remaining.find(file => file.path === comparison?.file) ?? remaining[Math.min(Math.max(0, fileIndex), remaining.length - 1)]!;
        const multi = !(preserve.input instanceof vscode.TabInputTextDiff) && hunk === undefined;
        await openReviewChanges(reviews, { project: request.project, revision: result.revision, file: multi ? undefined : file.path, group }, changeNavigation);
        reopened = vscode.window.tabGroups.activeTabGroup.activeTab === preserve;
        const editor = vscode.window.activeTextEditor;
        if (editor && hunk !== undefined) {
          const position = new vscode.Position(Math.min(line, editor.document.lineCount - 1), 0);
          editor.selection = new vscode.Selection(position, position); editor.revealRange(editor.selection);
        }
      }
      // An accepted/reverted comparison must not remain as an apparently pending diff.
      const stillPending = comparisons.some(file => preserve?.input instanceof vscode.TabInputTextDiff && file.original.toString() === preserve.input.original.toString() && file.modified.toString() === preserve.input.modified.toString());
      if (preserve && !reopened && !stillPending && vscode.window.tabGroups.all.some(group => group.tabs.includes(preserve))) await vscode.window.tabGroups.close(preserve, true);
    } finally {
      reviewing = false;
      if (!disposed && state.project === request.project) { state.reviewBusy = false; await refreshReview(request.project); update(); }
    }
  };
  register('agentTandem.acceptChanges', value => decideReview(value, false));
  register('agentTandem.revertChanges', value => decideReview(value, true));
  register('agentTandem.confirmRevert', async value => {
    const plan = state.revertPreview;
    if (!plan || !value || typeof value !== 'object' || (value as { token?: string }).token !== plan.token) throw new Error('Preview the Revert before confirming.');
    await decideReview({ ...plan.request, ...(plan.hunk ? { hunk: plan.hunk } : {}) }, true);
  });
  register('agentTandem.undoRevert', async value => {
    const project = state.project, undo = state.review?.undo;
    if (!project || !undo || (value !== undefined && (!value || typeof value !== 'object' || (value as { id?: string }).id !== undo.id || (value as { project?: string }).project !== project))) throw new Error('This Revert is no longer available to Undo.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before undoing Revert.');
    await settleExternalCapture();
    if (chatAbort || reviewing || externalJob || externalSwitching) throw new Error('Wait for the agent and change capture to finish.');
    const dirty = vscode.workspace.textDocuments.find(document => document.isDirty && undo.files.some(file => vscode.Uri.joinPath(vscode.Uri.file(project), file).toString().toLowerCase() === document.uri.toString().toLowerCase()));
    if (dirty) throw new Error(`Cannot undo ${path.basename(dirty.uri.fsPath)} while it has unsaved edits. Your edits were kept.`);
    reviewing = true; state.reviewBusy = true; state.error = undefined; update();
    try {
      const result = await reviews.undoRevert(project, undo.id);
      if (disposed || project !== state.project) return;
      state.review = result; state.revertPreview = undefined;
      await changeNavigation.refreshReview(project, result.files.map(file => ({ file: file.path, original: reviewSnapshotUri(file.before, file.path), modified: reviewSnapshotUri(file.after, file.path), review: { project, revision: result.revision, group: reviewGroup(file) } })));
    } finally { reviewing = false; if (!disposed && project === state.project) { state.reviewBusy = false; await refreshReview(project); update(); } }
  });
  hunkActions = new ReviewHunkActions(reviews, changeNavigation,
    () => ({ project: state.project, review: state.review, busy: !!chatAbort || reviewing || !!state.review?.busy }),
    decideReview, report);
  context.subscriptions.push(hunkActions);
  reviewEditor = new ReviewWebview(context.extensionUri, reviews,
    () => ({ project: state.project, review: state.review, conversations: state.conversations, busy: !!chatAbort || reviewing || externalSwitching, capturing: externalJob }),
    async (command, value) => vscode.commands.executeCommand(command, value),
    request => openReviewChanges(reviews, request, changeNavigation, () => !disposed && request.project === state.project && request.revision === state.review?.revision));
  context.subscriptions.push(reviewEditor);
  function checkpointRequest(value: unknown) {
    if (!value || typeof value !== 'object') throw new Error('Choose a message checkpoint.');
    const request = value as { project: string; id: string; token?: string };
    if (request.project !== state.project || typeof request.id !== 'string') throw new Error('The checkpoint project changed.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before restoring a checkpoint.');
    if (chatAbort || reviewing || cliManaging || state.running) throw new Error('Wait for the active operation to finish before restoring a checkpoint.');
    return request;
  }
  register('agentTandem.previewCheckpoint', async value => {
    const request = checkpointRequest(value), version = ++uiGeneration;
    const key = state.conversation?.conversation.key;
    reviewing = true; state.reviewBusy = true; state.error = undefined; update();
    try {
      const available = state.conversation ? await checkpoints.list(request.project, state.conversation) : [];
      const undo = await checkpoints.undo(request.project);
      if (!available.some(entry => entry.id === request.id) && undo?.id !== request.id) throw new Error('This checkpoint does not belong to the selected conversation.');
      const saved = await checkpoints.get(request.project, request.id);
      const plan = await reviews.prepareCheckpoint(request.project, saved.snapshot);
      if (!disposed && state.project === request.project && key === state.conversation?.conversation.key && version === uiGeneration) {
        const token = randomUUID(); checkpointPlan = { project: request.project, key, id: request.id, token, plan };
        state.checkpointPreview = { id: request.id, token, files: plan.files, createdAt: saved.createdAt, undo: !!saved.undo }; state.screen = 'conversations';
      }
    } finally { reviewing = false; state.reviewBusy = false; update(); }
  });
  register('agentTandem.closeCheckpointPreview', () => { uiGeneration++; checkpointPlan = undefined; state.checkpointPreview = undefined; update(); });
  register('agentTandem.restoreCheckpoint', async value => {
    const request = checkpointRequest(value), selected = checkpointPlan;
    if (!selected || selected.project !== request.project || selected.id !== request.id || selected.token !== request.token || selected.key !== state.conversation?.conversation.key) throw new Error('Preview this checkpoint again before restoring.');
    const dirty = vscode.workspace.textDocuments.find(document => document.isDirty && document.uri.scheme === 'file' && belongsToProject(path.dirname(document.uri.fsPath), request.project));
    if (dirty) throw new Error(`Save ${path.basename(dirty.uri.fsPath)} before restoring. Your unsaved edits were kept.`);
    reviewing = true; state.reviewBusy = true; state.error = undefined; update();
    try {
      const review = await reviews.restoreCheckpoint(request.project, selected.plan, async snapshot => {
        const undo = await checkpoints.saveUndo(request.project, snapshot);
        if (!disposed && state.project === request.project) state.checkpointUndo = undo;
      });
      if (!disposed && state.project === request.project) {
        state.review = review; state.reviewPreview = undefined; state.checkpointPreview = undefined; checkpointPlan = undefined;
        if (state.conversation) state.conversation.notice = 'Code restored to the checkpoint. Chat history was kept; edit and resend a message to start a new branch.';
      }
    } catch (error) {
      // Any partial writes are journalled and remain reviewable; the pre-restore backup is retained.
      checkpointPlan = undefined; state.checkpointPreview = undefined; throw error;
    } finally {
      reviewing = false;
      if (!disposed && state.project === request.project) { state.reviewBusy = false; await refreshReview(request.project); update(); }
    }
  });
  register('agentTandem.showSection', async screen => {
    if (screen !== 'conversations' && screen !== 'changes' && screen !== 'tools' && screen !== 'cli') throw new Error('Unknown section.');
    uiGeneration++; state.screen = screen; update(); if (screen === 'cli') void refreshCLIManager();
    if (screen === 'changes') await captureExternalReview();
  });
  register('agentTandem.syncConversations', async () => { const index = await syncConversations(); await preview.open(); return index; });
  register('agentTandem.openConversation', async key => {
    if (typeof key !== 'string') throw new Error('Invalid conversation selection.');
    const version = ++uiGeneration;
    const content = await openConversation(key);
    if (version === uiGeneration) { state.screen = 'conversations'; update(); await preview.open(); }
    return content;
  });
  register('agentTandem.runDemo', async () => { uiGeneration++; state.screen = 'changes'; state.changePreview = undefined; update(); await preview.open(); return run(); });
  register('agentTandem.stop', () => cancel?.abort());
  const inlineChanges = async (selected: unknown, cumulative: boolean) => {
    const version = ++uiGeneration;
    const result = await readChangePreview(history, state.sessions, selectionFrom(selected), cumulative);
    if (version === uiGeneration && !disposed) {
      state.changePreview = result; state.screen = 'changes'; update();
      if (result.files.length) await openChanges(history, state.sessions, selectionFrom(selected), cumulative, changeNavigation);
      else await preview.open();
    }
    return result;
  };
  register('agentTandem.openStep', selected => inlineChanges(selected, false));
  register('agentTandem.openFile', selected => inlineChanges(selected, false));
  register('agentTandem.openCumulative', selected => inlineChanges(selected, true));
  register('agentTandem.previewFile', file => {
    const current = state.changePreview;
    if (!current || typeof file !== 'string') throw new Error('Choose a recorded change first.');
    return inlineChanges({ ...current.selection, file }, current.cumulative);
  });
  register('agentTandem.openStepInEditor', selected => openChanges(history, state.sessions, selectionFrom(selected), false, changeNavigation));
  register('agentTandem.openFileInEditor', selected => openChanges(history, state.sessions, selectionFrom(selected), false, changeNavigation, true));
  register('agentTandem.openCumulativeInEditor', selected => openChanges(history, state.sessions, selectionFrom(selected), true, changeNavigation));
  register('agentTandem.checkProviders', async () => {
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before starting provider processes.');
    const config = vscode.workspace.getConfiguration('agentTandem');
    const version = ++uiGeneration;
    state.providers = await Promise.all((['Codex', 'Claude'] as const).map(async provider => {
      try { const selected = await managedCLI(provider, state.project); return provider === 'Codex' ? await probeCodex(selected.cli.executable) : await probeClaude(selected.cli.executable); }
      catch (error) { cliResolver.invalidateOnFailure(provider, error); return { provider, available: false, detail: (error as Error).message }; }
    }));
    for (const provider of state.providers) output.appendLine(`${provider.provider}: ${provider.detail}`);
    if (version === uiGeneration) { state.screen = 'tools'; update(); await preview.open(); }
    return state.providers;
  });
  const timer = setInterval(() => { void syncConversations(true).catch(error => { state.syncErrors = [error instanceof Error ? error.message : 'Sync failed.']; update(); }); }, 5000);
  const accountTimer = setInterval(() => { void refreshAccounts(); }, 60000);
  const storageUsageTimer = setInterval(() => { void refreshStorageUsage(); }, 5 * 60000);
  const storageUsageStartup = setTimeout(() => { void refreshStorageUsage(); }, 3000);
  const followRoot = () => {
    if (!setCurrentRoot()) return;
    cliResolver.invalidate();
    saveQueue();
    void Promise.all([restoreAccessModes(), restoreModels(), restoreEfforts(), restoreFastMode(), refreshCLIManager()]).then(update).catch(report);
    void loadModels(state.composeProvider ?? 'Codex');
    refreshAccounts();
    void refreshReview(state.project, true).catch(report);
    const previous = syncJob;
    void (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => syncConversations()).catch(report);
  };
  context.subscriptions.push({ dispose: () => { disposed = true; externalWatcher?.dispose(); clearTimeout(externalTimer); chatAbort?.abort(); usageAbort?.abort(); for (const job of modelJobs.values()) job.abort.abort(); for (const job of accountJobs.values()) job.abort.abort(); generation++; selectionGeneration++; clearInterval(timer); clearInterval(accountTimer); clearInterval(storageUsageTimer); clearTimeout(storageUsageStartup); } },
    vscode.extensions.onDidChange(() => {
      const revision = codexExtensionIdentity();
      if (revision === codexExtensionRevision) return;
      codexExtensionRevision = revision; cliResolver.invalidate('Codex');
      modelJobs.get('Codex')?.abort.abort(); modelJobs.delete('Codex');
      state.modelCatalogs = { ...state.modelCatalogs, Codex: undefined };
      void refreshCLIManager(); void loadModels('Codex', true); void loadAccount('Codex', true);
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { cliResolver.invalidate(); void refreshReview(state.project, true).catch(report); void refreshCLIManager(); refreshAccounts(); void loadModels(state.conversation?.conversation.provider ?? state.composeProvider ?? 'Codex'); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('agentTandem.storageWarningMB')) void refreshStorageUsage(true);
      if (event.affectsConfiguration('agentTandem.showQuotaInStatusBar') || event.affectsConfiguration('agentTandem.usageDashboardDefaultGrouping') || Object.values(STATUS_BAR_CONFIGURATION).some(key => event.affectsConfiguration(`agentTandem.${key}`))) update();
      if (event.affectsConfiguration('agentTandem.autoTrackExternalChanges')) void refreshReview(state.project).catch(report);
      if (!['codexExecutable', 'claudeExecutable', 'codexCLISelection', 'claudeCLISelection', 'codexCLIId', 'claudeCLIId'].some(key => event.affectsConfiguration(`agentTandem.${key}`))) return;
      cliResolver.invalidate();
      for (const job of modelJobs.values()) job.abort.abort(); modelJobs.clear(); state.modelCatalogs = {};
      resetAccounts();
      void refreshCLIManager();
      void loadModels(state.conversation?.conversation.provider ?? state.composeProvider ?? 'Codex');
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(followRoot),
    vscode.window.onDidChangeActiveTextEditor(followRoot));
  void syncConversations().catch(error => { state.syncErrors = [error instanceof Error ? error.message : 'Sync failed.']; update(); });
  void refreshCLIManager();
  refreshAccounts();
  void loadModels(state.conversation?.conversation.provider ?? state.composeProvider ?? 'Codex');
  const onboardingShown = await vscode.workspace.fs.stat(onboardingMarker).then(() => true, error => {
    if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return false;
    throw error;
  });
  if (!onboardingShown) await showGettingStarted().catch(report);
  return {
    usageDashboard: dashboardState,
    changeNavigationState: () => changeNavigation.state(),
    reviewWebviewState: () => reviewEditor?.state,
    sessions: () => state.sessions, runDemo: run, stop: () => cancel?.abort(), history,
    syncConversations, openConversation, conversation: () => state.conversation,
    viewState: () => state, viewResolved: () => preview.resolved,
    refreshFromStorage: async () => {
      if (state.running) throw new Error('Cannot reload history during a run.');
      state.sessions = await history.sessions(); update();
    },
  };
}

export function deactivate() { cancel?.abort(); }
