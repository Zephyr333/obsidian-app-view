export interface MarkdownState { mode: 'source' | 'preview'; source?: boolean }
export interface PluginSettings {
  viewName: string;
  noteStates: Record<string, 'detail' | 'app'>;
  markdownStates: Record<string, MarkdownState>;
}

/** Do not share mutable defaults across reloads; ignore malformed persisted entries. */
export function loadPreferences(raw: unknown): PluginSettings {
  const settings: PluginSettings = {viewName: '速查版', noteStates: {}, markdownStates: {}};
  if (!raw || typeof raw !== 'object') return settings;
  const data = raw as Record<string, unknown>;
  if (typeof data.viewName === 'string' && data.viewName.trim()) {
    settings.viewName = ['行动版', '应用版'].includes(data.viewName) ? '速查版' : data.viewName.trim();
  }
  if (data.noteStates && typeof data.noteStates === 'object') {
    for (const [path, value] of Object.entries(data.noteStates)) {
      if (path.endsWith('.md') && (value === 'detail' || value === 'app')) Object.defineProperty(settings.noteStates, path, {value, writable: true, enumerable: true, configurable: true});
    }
  }
  if (data.markdownStates && typeof data.markdownStates === 'object') {
    for (const [path, value] of Object.entries(data.markdownStates)) {
      if (path.endsWith('.md') && value && (value.mode === 'source' || value.mode === 'preview')) {
        Object.defineProperty(settings.markdownStates, path, {value: {mode: value.mode, source: value.mode === 'source' && value.source === true}, writable: true, enumerable: true, configurable: true});
      }
    }
  }
  return settings;
}

export function remapPreferences(settings: PluginSettings, oldPath: string, newPath?: string) {
  for (const states of [settings.noteStates, settings.markdownStates]) {
    for (const path of Object.keys(states)) {
      if (path !== oldPath && !path.startsWith(oldPath + '/')) continue;
      if (newPath !== undefined) Object.defineProperty(states, newPath + path.slice(oldPath.length), {value: states[path], writable: true, enumerable: true, configurable: true});
      delete states[path];
    }
  }
}

/** Native leaf navigation is not reentrant. Queue complete operations, not event callbacks. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
  async settled() { await this.tail; }
}
