export type Manifest = Record<string, string>;
export interface Snapshot { id: string; files: Manifest }
export interface FileChange { path: string; before?: string; after?: string; kind: 'added' | 'modified' | 'deleted'; binary: boolean }
export interface Step {
  id: string;
  title: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  before: string;
  after?: string;
  changes: FileChange[];
  output: string;
  captureMode: 'exact' | 'grouped';
}
export interface Session {
  version: 1;
  id: string;
  title: string;
  source: 'demo';
  createdAt: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  baseline: string;
  steps: Step[];
}
export interface ProviderStatus {
  provider: 'Codex' | 'Claude';
  available: boolean;
  version?: string;
  executable?: string;
  protocol?: string;
  detail: string;
}
export interface ViewState {
  sessions: Session[];
  running: boolean;
  providers: ProviderStatus[];
  error?: string;
  project?: string;
  projectName?: string;
  conversations?: import('../providers/conversations').Conversation[];
  conversation?: import('../providers/conversations').ConversationContent;
  syncing?: boolean;
  syncErrors?: string[];
  syncedAt?: number;
  screen?: 'conversations' | 'changes' | 'tools' | 'cli';
  cliManager?: import('../providers/cli-registry').CLIManagerState;
  changePreview?: import('./change-preview').ChangePreview;
  chat?: import('../providers/chat').ChatState;
  chatQueue?: import('./chat-queue').ChatQueueState;
  composeProvider?: import('../providers/conversations').ConversationProvider;
  accessModes?: import('../providers/access').AccessModes;
  selectedModels?: import('../providers/models').SelectedModels;
  selectedEfforts?: import('../providers/effort').SelectedEfforts;
  codexFastMode?: boolean;
  modelCatalogs?: Partial<Record<import('../providers/conversations').ConversationProvider, import('../providers/models').ModelCatalog>>;
  accounts?: Partial<Record<import('../providers/conversations').ConversationProvider, import('../providers/account-status').ProviderAccountStatus>>;
  review?: import('./review').ReviewState;
  reviewPreview?: import('./review').ReviewPreview;
  reviewBusy?: boolean;
  revertPreview?: { token: string; request: import('./review').ReviewRequest; hunk?: string; files: import('./review').ReviewFile[] };
  checkpoints?: import('./checkpoints').MessageCheckpoint[];
  checkpointPreview?: import('./checkpoints').CheckpointPreview;
  checkpointUndo?: { id: string; createdAt: number };
}
