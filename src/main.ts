import {
  App,
  Component,
  FileView,
  Keymap,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  setIcon,
  type Editor,
  type Command,
  type ViewStateResult,
  WorkspaceLeaf
} from 'obsidian';
import { rangeExtension } from './editor';
import {
  addRangeEdit,
  detectBlockAt,
  parseRanges,
  removeRangeEdit,
  removeSpecificRangeEdit,
  toggleCheckboxInSource,
  clearRangeMarkers,
  taskOffsets,
  type TextEdit
} from './ranges';
import { loadPreferences, remapPreferences, SerialQueue, type MarkdownState, type PluginSettings } from './state';

const VIEW = 'app-view';

class ApplicationView extends FileView {
  path = '';
  private generation = 0;
  private rendered?: Component;
  private lastText?: string;
  private heading!: HTMLElement;
  private body!: HTMLElement;
  private timer?: number;
  private timerWindow?: Window;
  private targetScrollOffset?: number;
  private managing = false;
  private backActionEl: HTMLElement;
  private copyActionEl: HTMLElement;
  private floatingBar?: { el: HTMLElement; cleanup: () => void };

  constructor(leaf: WorkspaceLeaf, private readonly owner: ApplicationPlugin) {
    super(leaf);
    this.navigation = true;
    this.allowNoFile = false;
    this.copyActionEl = this.addAction('copy', `复制${this.owner.settings.viewName}纯文本`, async () => {
      await this.copyContent();
    });
    const backActionEl = this.backActionEl = this.addAction('file-text', `左键：返回详细版 | 右键：管理${this.owner.settings.viewName}`, (evt: MouseEvent) => {
      void this.owner.openSource(this.path, evt, this.leaf);
    });
    backActionEl.addEventListener('contextmenu', (evt: MouseEvent) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.toggleManaging();
    });
  }

  canAcceptExtension(_extension: string) {
    return false;
  }

  async onLoadFile(file: TFile) {
    this.file = file;
    this.path = file.path;
    this.lastText = undefined;
    await this.refresh();
  }

  async onUnloadFile(_file: TFile) {
    this.file = null;
    this.path = '';
    this.lastText = undefined;
  }

  getViewType() { return VIEW; }
  getDisplayText() {
    const file = this.app.vault.getAbstractFileByPath(this.path);
    return file instanceof TFile ? file.basename : (this.path ? this.path.split('/').pop()?.replace(/\.md$/, '') ?? '' : this.owner.settings.viewName);
  }
  getIcon() { return 'zap'; }
  getState() { return { ...super.getState(), file: this.file?.path ?? this.path }; }
  async setState(state: unknown, result: ViewStateResult) {
    // Older workspaces used `path`; FileView owns file loading and lifecycle events.
    if (state && typeof state === 'object' && 'path' in state && !('file' in state)) state = { ...state, file: state.path };
    if (state && typeof state === 'object' && 'targetOffset' in state && typeof state.targetOffset === 'number') {
      this.targetScrollOffset = state.targetOffset;
    }
    this.lastText = undefined;
    await super.setState(state, result);
    await this.refresh();
  }

  async onOpen() {
    this.contentEl.addClass('app-view-container');
    this.contentEl.addClass('markdown-rendered');
    this.contentEl.addClass('markdown-preview-view');
    this.contentEl.addClass('is-readable-line-width');
    this.contentEl.toggleClass('has-block-gap', this.owner.settings.blankLineBetweenBlocks);

    this.heading = this.contentEl.createEl('div', { cls: 'inline-title' });
    this.body = this.contentEl.createDiv({ cls: 'app-view-body' });

    this.registerDomEvent(this.body, 'click', async (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      // 1. Task Checkbox toggle and write back to source
      if (target.instanceOf(HTMLInputElement) && target.type === 'checkbox') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!target.matches('.task-list-item-checkbox') || target.closest('.internal-embed')) return;
        const section = target.closest<HTMLElement>('.app-view-section');
        if (!section) return;
        const rangeIndex = parseInt(section.dataset.rangeIndex ?? '-1', 10);
        if (rangeIndex === -1) return;

        const allCheckboxes = Array.from(section.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox')).filter(e => !e.closest('.internal-embed'));
        const checkboxIndex = allCheckboxes.indexOf(target);
        if (checkboxIndex === -1) return;

        const file = this.app.vault.getAbstractFileByPath(this.path);
        if (file instanceof TFile) {
          await this.owner.editSource(file, this.lastText, content => {
            const updated = toggleCheckboxInSource(content, rangeIndex, checkboxIndex);
            if (updated === undefined) throw new Error('无法对应源任务，请刷新后重试。');
            return updated;
          });
          this.lastText = undefined;
          await this.refresh();
        }
        return;
      }

      // 2. Prevent arbitrary form inputs
      if (target.closest('textarea, select, [contenteditable="true"]')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      // 3. Internal link jump
      const link = target.closest('a.internal-link');
      const href = link?.getAttribute('data-href') ?? link?.getAttribute('href');
      if (href) {
        event.preventDefault();
        event.stopPropagation();
        void this.app.workspace.openLinkText(href, this.path, Keymap.isModEvent(event));
      }
    }, { capture: true });

    // 4. Link hover preview parity
    this.registerDomEvent(this.body, 'mouseover', (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const link = target?.closest<HTMLAnchorElement>('a.internal-link');
      if (link) {
        const href = link.getAttribute('data-href') ?? link.getAttribute('href');
        if (href) {
          this.app.workspace.trigger('link-hover', this, link, href, this.path);
        }
      }
    });

    // 5. Native reading-mode copy parity
    this.registerDomEvent(this.contentEl, 'keydown', (event: KeyboardEvent) => {
      const isMod = event.ctrlKey || event.metaKey;
      if (!isMod) return;

      if (event.key.toLowerCase() === 'a') {
        const target = event.target as HTMLElement | null;
        if (target?.closest('input, textarea, [contenteditable="true"]')) return;
        event.preventDefault();
        const selection = this.contentEl.ownerDocument.getSelection();
        if (selection) {
          selection.removeAllRanges();
          const range = this.contentEl.ownerDocument.createRange();
          range.selectNodeContents(this.body);
          selection.addRange(range);
          new Notice('已选中速查内容，按 Ctrl+C 复制');
        }
      } else if (event.key.toLowerCase() === 'c') {
        const target = event.target as HTMLElement | null;
        if (target?.closest('input, textarea, [contenteditable="true"]')) return;
        const selection = this.contentEl.ownerDocument.getSelection();
        if (!selection || selection.isCollapsed || selection.toString().trim().length === 0) {
          event.preventDefault();
          const bodyText = this.plainText();
          if (bodyText) {
            void this.contentEl.ownerDocument.defaultView?.navigator.clipboard.writeText(bodyText).then(() => {
              new Notice('已复制全文');
            });
          }
        }
      }
    });

    this.registerDomEvent(this.contentEl, 'copy', (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      const selection = this.contentEl.ownerDocument.getSelection();
      if (!selection || selection.isCollapsed || selection.toString().trim().length === 0) {
        event.preventDefault();
        const bodyText = this.plainText();
        if (bodyText && event.clipboardData) {
          event.clipboardData.setData('text/plain', bodyText);
          new Notice('已复制全文');
        }
      } else if (event.clipboardData) {
        const range = selection.getRangeAt(0);
        if (range.startContainer === this.body && range.startOffset === 0 && range.endContainer === this.body && range.endOffset === this.body.childNodes.length) {
          event.clipboardData.setData('text/plain', this.plainText());
          event.preventDefault();
        }
        // Keep native selection copying (including line/table formatting) for
        // an ordinary partial selection.
      }
    });

    await this.refresh();
  }

  scheduleRefresh() {
    this.clearTimer();
    this.timerWindow = this.contentEl.ownerDocument.defaultView ?? undefined;
    this.timer = this.timerWindow?.setTimeout(() => { this.timer = undefined; void this.refresh(); }, 180);
  }

  private clearTimer() { if (this.timer !== undefined) this.timerWindow?.clearTimeout(this.timer); this.timer = undefined; }

  toggleManaging() {
    this.managing = !this.managing;
    this.contentEl.toggleClass('is-managing', this.managing);
    if (this.managing) {
      this.mountQuickViewFloatingBar();
    } else {
      this.unmountQuickViewFloatingBar();
    }
  }

  private mountQuickViewFloatingBar() {
    this.unmountQuickViewFloatingBar();
    const bar = this.containerEl.createDiv({ cls: 'app-view-floating-bar' });
    bar.createSpan({ cls: 'app-view-floating-label', text: `${this.owner.settings.viewName}管理中` });

    const parsed = parseRanges(this.lastText ?? '');
    bar.createSpan({ cls: 'app-view-floating-count', text: `共 ${parsed.ranges.length} 段` });

    const addBtn = bar.createEl('button', { cls: 'app-view-floating-btn', text: '去详细版添加内容' });
    const clearBtn = bar.createEl('button', { cls: 'app-view-floating-btn', text: '清空全部标记' });
    const doneBtn = bar.createEl('button', { cls: 'app-view-floating-btn mod-cta', text: '完成管理 (Esc)' });

    for (const btn of [addBtn, clearBtn]) {
      btn.addEventListener('mousedown', e => e.preventDefault());
    }
    addBtn.addEventListener('click', async () => {
      this.toggleManaging();
      await this.owner.openSource(this.path, undefined, this.leaf);
      if (!this.owner.isEditing()) this.owner.toggleRanges();
    });
    clearBtn.addEventListener('click', async () => {
      const file = this.app.vault.getAbstractFileByPath(this.path);
      if (file instanceof TFile) {
        await this.owner.clearAllRangesInFile(file);
      }
    });
    doneBtn.addEventListener('click', () => this.toggleManaging());

    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.toggleManaging();
      }
    };
    this.containerEl.ownerDocument.addEventListener('keydown', onKeydown);

    this.floatingBar = {
      el: bar,
      cleanup: () => {
        this.containerEl.ownerDocument.removeEventListener('keydown', onKeydown);
        bar.remove();
      }
    };
  }

  private unmountQuickViewFloatingBar() {
    if (this.floatingBar) {
      this.floatingBar.cleanup();
      this.floatingBar = undefined;
    }
  }

  async refresh() {
    if (!this.body) return;
    this.contentEl.toggleClass('has-block-gap', this.owner.settings.blankLineBetweenBlocks);
    const generation = ++this.generation;
    const file = this.app.vault.getAbstractFileByPath(this.path);
    this.heading.setText(file instanceof TFile ? file.basename : '');

    if (!(file instanceof TFile)) {
      this.lastText = undefined;
      this.disposeRendering();
      this.body.empty();
      this.body.createDiv({ cls: 'app-view-empty', text: '源笔记不存在。' });
      return;
    }

    let text: string;
    try { text = await this.owner.sourceText(file); }
    catch {
      if (generation === this.generation) {
        this.body.empty();
        this.body.createDiv({ cls: 'app-view-empty', text: '暂时无法读取源笔记。' });
      }
      return;
    }

    if (generation !== this.generation || this.lastText === text) return;
    const parsed = parseRanges(text);

    if (parsed.errors.length) {
      this.lastText = undefined;
      this.disposeRendering();
      this.body.empty();
      this.body.createDiv({ cls: 'app-view-empty', text: `范围标记需要修正：${parsed.errors.join(' ')}` });
      return;
    }

    const staging = this.body.ownerDocument.createDocumentFragment().createDiv();
    const component = new Component();
    this.addChild(component);

    try {
      if (parsed.ranges.length === 0) {
        staging.createDiv({
          cls: 'app-view-empty',
          text: `未收录任何${this.owner.settings.viewName}内容。在详细版中选中内容，右键点击“加入${this.owner.settings.viewName}”。`
        });
      } else {
        for (const [index, range] of parsed.ranges.entries()) {
          if (!range.text.trim()) continue;
          const section = staging.createEl('section', { cls: 'app-view-section' });
          section.dataset.rangeIndex = String(index);
          section.dataset.from = String(range.from);
          section.dataset.to = String(range.to);

          // Management header with delete button
          const manageHeader = section.createDiv({ cls: 'app-view-manage-header' });
          manageHeader.createSpan({ cls: 'app-view-manage-badge', text: `段落 ${index + 1}` });
          const delBtn = manageHeader.createEl('button', { cls: 'app-view-manage-del', text: '移除本段' });
          delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            void this.owner.removeRangeAt(this.path, range.from, range.to, text);
          });

          // Bidirectional locate button
          const locateBtn = section.createEl('button', {
            cls: 'app-view-locate-btn',
            attr: { 'aria-label': '定位到详细版对应位置' }
          });
          setIcon(locateBtn, 'arrow-up-right');
          locateBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            void this.owner.jumpToSource(this.path, range.from, this.leaf);
          });

          section.addEventListener('dblclick', (e) => {
            const target = e.target as HTMLElement;
            if (!target.closest('button, a, input')) {
              void this.owner.jumpToSource(this.path, range.from, this.leaf);
            }
          });

          const content = section.createDiv({cls: 'app-view-rendered'});
          await MarkdownRenderer.render(this.app, range.text, content, file.path, component);
          const tasks = Array.from(content.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox')).filter(e => !e.closest('.internal-embed'));
          if (tasks.length !== taskOffsets(range.text).length) {
            for (const task of tasks) { task.disabled = true; task.title = '此结构无法安全对应源任务，请在详细版修改。'; }
          }
          for (const input of Array.from(content.querySelectorAll<HTMLInputElement>('input:not(.task-list-item-checkbox), .internal-embed input'))) input.disabled = true;
          if (generation !== this.generation) { this.removeChild(component); return; }
        }
        for (const editable of Array.from(staging.querySelectorAll<HTMLElement>('[contenteditable]'))) editable.setAttribute('contenteditable', 'false');
      }

      const scroll = this.contentEl.scrollTop;
      this.disposeRendering();
      this.rendered = component;
      this.body.replaceChildren(...Array.from(staging.childNodes));
      this.lastText = text;
      if (this.managing) this.mountQuickViewFloatingBar();

      // Scroll to target offset if requested
      if (this.targetScrollOffset !== undefined) {
        const targetOffset = this.targetScrollOffset;
        this.targetScrollOffset = undefined;
        const sections = Array.from(this.body.querySelectorAll<HTMLElement>('.app-view-section'));
        const match = sections.find(s => {
          const from = parseInt(s.dataset.from ?? '0', 10);
          const to = parseInt(s.dataset.to ?? '0', 10);
          return targetOffset >= from && targetOffset <= to;
        }) ?? sections.reduce<HTMLElement | undefined>((best, section) => !best || Math.abs(Number(section.dataset.from) - targetOffset) < Math.abs(Number(best.dataset.from) - targetOffset) ? section : best, undefined);
        if (match) {
          match.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } else {
        this.contentEl.scrollTop = scroll;
      }
    } catch {
      this.removeChild(component);
      if (generation === this.generation) {
        this.body.empty();
        this.body.createDiv({ cls: 'app-view-empty', text: '内容渲染失败，请返回详细版检查后重试。' });
      }
    }
  }

  async copyContent() {
    const file = this.app.vault.getAbstractFileByPath(this.path);
    if (!(file instanceof TFile)) return;
    const text = await this.owner.sourceText(file);
    const parsed = parseRanges(text);
    if (parsed.errors.length) { new Notice(parsed.errors[0]); return; }
    if (parsed.ranges.length === 0) {
      new Notice(`当前没有可复制的${this.owner.settings.viewName}内容。`);
      return;
    }
    if (text !== this.lastText) await this.refresh();
    await this.contentEl.ownerDocument.defaultView?.navigator.clipboard.writeText(this.plainText());
    new Notice(`已复制${this.owner.settings.viewName}纯文本到剪贴板`);
  }

  private plainText() {
    return Array.from(this.body.querySelectorAll<HTMLElement>('.app-view-rendered')).map(el => el.innerText.trim()).filter(Boolean).join('\n\n');
  }

  updateName() {
    this.backActionEl.setAttribute('aria-label', `左键：返回详细版 | 右键：管理${this.owner.settings.viewName}`);
    this.copyActionEl.setAttribute('aria-label', `复制${this.owner.settings.viewName}纯文本`);
    if (this.managing) this.mountQuickViewFloatingBar();
  }

  private disposeRendering() { if (this.rendered) this.removeChild(this.rendered); this.rendered = undefined; }
  async onClose() { this.generation++; this.clearTimer(); this.unmountQuickViewFloatingBar(); this.disposeRendering(); }
}

export default class ApplicationPlugin extends Plugin {
  settings: PluginSettings = loadPreferences(null);
  private editing = false;
  decorations = rangeExtension(
    () => this.editing,
    () => this.settings.viewName
  );
  private leafActions = new Map<WorkspaceLeaf, { showEl: HTMLElement; cleanup: () => void }>();
  private floatingBar?: { el: HTMLElement; countEl: HTMLElement; cleanup: () => void };
  private readonly saves = new SerialQueue();
  private readonly navigation = new WeakMap<WorkspaceLeaf, SerialQueue>();
  private readonly observedMarkdown = new WeakMap<WorkspaceLeaf, {path: string; mode: string; source: boolean}>();
  private readonly navigating = new WeakSet<WorkspaceLeaf>();
  private stopped = false;
  private namedCommands: {command: Command; label: string}[] = [];
  private ribbonEl?: HTMLElement;

  isEditing() {
    return this.editing;
  }

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW, leaf => new ApplicationView(leaf, this));
    this.registerEditorExtension(this.decorations.extension);

    this.addSettingTab(new ApplicationSettingTab(this.app, this));

    this.addNamedCommand({
      id: 'show-application',
      name: `查看${this.settings.viewName}`,
      checkCallback: checking => {
        const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!mdView?.file) return false;
        if (!checking) void this.openApplication(mdView.file, undefined, mdView.leaf);
        return true;
      }
    });

    this.addNamedCommand({
      id: 'toggle-ranges',
      name: `显示／隐藏${this.settings.viewName}范围`,
      callback: () => {
        const quick = this.app.workspace.getActiveViewOfType(ApplicationView);
        if (quick) quick.toggleManaging(); else this.toggleRanges();
      }
    });

    this.addNamedCommand({
      id: 'include-selection',
      name: `加入${this.settings.viewName}`,
      editorCallback: editor => this.include(editor)
    });

    this.addNamedCommand({
      id: 'exclude-range',
      name: `取消当前${this.settings.viewName}范围`,
      editorCallback: editor => this.exclude(editor)
    });

    this.addNamedCommand({
      id: 'clear-all-ranges',
      name: `清除当前笔记所有${this.settings.viewName}标记`,
      editorCallback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) this.clearAllRanges(view);
      }
    });

    this.addNamedCommand({
      id: 'copy-application-content',
      name: `复制当前${this.settings.viewName}纯文本`,
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(ApplicationView);
        if (!view) return false;
        if (!checking) void view.copyContent();
        return true;
      }
    });

    this.ribbonEl = this.addRibbonIcon('zap', `详细版／${this.settings.viewName}`, (evt: MouseEvent) => {
      const appView = this.app.workspace.getActiveViewOfType(ApplicationView);
      if (appView) void this.openSource(appView.path, evt, appView.leaf);
      else {
        const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (mdView?.file) void this.openApplication(mdView.file, evt, mdView.leaf);
        else new Notice('请先打开一篇详细笔记。');
      }
    });

    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor) => {
      const hasSelection = editor.somethingSelected();
      const text = editor.getValue();
      const parsed = parseRanges(text);

      menu.addSeparator();
      if (hasSelection) {
        const from = editor.posToOffset(editor.getCursor('from'));
        const to = editor.posToOffset(editor.getCursor('to'));
        const isEnclosed = parsed.ranges.some(r => from >= r.from && to <= r.to);

        if (isEnclosed) {
          menu.addItem(item =>
            item.setTitle(`移除${this.settings.viewName}`)
              .setIcon('minus-circle')
              .onClick(() => this.exclude(editor))
          );
        } else {
          menu.addItem(item =>
            item.setTitle(`加入${this.settings.viewName}`)
              .setIcon('plus-circle')
              .onClick(() => this.include(editor))
          );
        }
      } else {
        const cursorOffset = editor.posToOffset(editor.getCursor());
        const block = detectBlockAt(text, cursorOffset);

        if (block) {
          if (block.isEnclosed) {
            menu.addItem(item =>
              item.setTitle(`移除${this.settings.viewName}`)
                .setIcon('minus-circle')
                .onClick(() => this.exclude(editor))
            );
          } else {
            menu.addItem(item =>
              item.setTitle(`加入${block.label}`)
                .setIcon('plus-circle')
                .onClick(() => this.includeRange(editor, block.from, block.to))
            );
          }
        }
        menu.addItem(item =>
          item.setTitle(this.editing ? `退出${this.settings.viewName}调整` : `调整${this.settings.viewName}范围`)
            .setIcon('sliders-horizontal')
            .onClick(() => this.toggleRanges())
        );
      }
    }));

    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'md') {
        menu.addItem(item => item.setTitle(`查看${this.settings.viewName}`).setIcon('zap').onClick(() => this.openApplication(file)));
      }
    }));

    this.registerEvent(this.app.workspace.on('editor-change', (_editor, info) => {
      this.updateViews(info.file?.path);
      this.updateFloatingBar();
    }));

    this.registerEvent(this.app.vault.on('modify', file => this.updateViews(file.path)));
    this.registerEvent(this.app.vault.on('delete', file => {
      this.updateViews(file.path);
      remapPreferences(this.settings, file.path);
      void this.saveSettings();
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      remapPreferences(this.settings, oldPath, file.path);
      for (const view of this.applicationViews()) {
        if (view.path === oldPath) view.path = file.path;
        else if (view.path.startsWith(oldPath + '/')) view.path = file.path + view.path.slice(oldPath.length);
        view.scheduleRefresh();
      }
      void this.saveSettings();
      this.app.workspace.requestSaveLayout();
    }));

    this.installNavigation();
    // These events observe only. Calling setViewState inside file-open loses the
    // request because the native openFile/setViewState transaction is still busy.
    this.registerEvent(this.app.workspace.on('layout-change', () => {
      this.syncActions();
      this.observeMarkdownModes();
      this.updateFloatingBarHost();
    }));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      this.syncActions();
      this.observeMarkdownModes();
      this.updateFloatingBarHost();
    }));
    this.app.workspace.onLayoutReady(() => {
      this.syncActions();
      this.observeMarkdownModes();
    });
  }

  async loadSettings() {
    this.settings = loadPreferences(await this.loadData());
  }

  async saveSettings() {
    // Snapshot on request and serialize disk writes, including mode and name edits.
    const snapshot = JSON.parse(JSON.stringify(this.settings)) as PluginSettings;
    await this.saves.run(() => this.saveData(snapshot));
  }

  private queueFor(leaf: WorkspaceLeaf) {
    let queue = this.navigation.get(leaf);
    if (!queue) { queue = new SerialQueue(); this.navigation.set(leaf, queue); }
    return queue;
  }

  private rememberMarkdown(leaf: WorkspaceLeaf) {
    if (!(leaf.view instanceof MarkdownView) || !leaf.view.file) return;
    const path = leaf.view.file.path;
    const state = {mode: leaf.view.getMode(), source: leaf.view.getState().source === true};
    this.observedMarkdown.set(leaf, {path, ...state});
    const saved = this.settings.markdownStates[path];
    if (saved?.mode === state.mode && saved.source === state.source) return;
    this.settings.markdownStates[path] = state;
    void this.saveSettings();
  }

  private observeMarkdownModes() {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (this.navigating.has(leaf) || !(leaf.view instanceof MarkdownView) || !leaf.view.file) continue;
      const now = {path: leaf.view.file.path, mode: leaf.view.getMode(), source: leaf.view.getState().source === true};
      const before = this.observedMarkdown.get(leaf);
      this.observedMarkdown.set(leaf, now);
      // Focus/layout restoration is not user intent. Only a mode change in the
      // same file updates its detailed-mode preference.
      if (before?.path === now.path && (before.mode !== now.mode || before.source !== now.source)) this.rememberMarkdown(leaf);
    }
  }

  private installNavigation() {
    const owner = this;
    const original = WorkspaceLeaf.prototype.openFile;
    const wrapped: typeof original = function(this: WorkspaceLeaf, file, options) {
      if (owner.stopped || file.extension !== 'md') return original.call(this, file, options);
      return owner.queueFor(this).run(async () => {
        if (owner.stopped || !this.parent) return;
        owner.rememberMarkdown(this);
        owner.navigating.add(this);
        try {
          // An already-open leaf keeps its own mode, even when another split
          // has changed this note's default for FUTURE opens.
          const currentPath = this.view instanceof FileView ? this.view.file?.path : undefined;
          const mode = currentPath === file.path
            ? (this.view.getViewType() === VIEW ? 'app' : 'detail')
            : owner.settings.noteStates[file.path] ?? 'detail';
          const text = mode === 'app' ? await owner.sourceText(file) : '';
          const parsed = parseRanges(text);
          if (mode === 'app' && (parsed.ranges.length || parsed.errors.length)) {
            await this.setViewState({type: VIEW, state: {file: file.path}, active: options?.active ?? this === owner.app.workspace.activeLeaf, group: options?.group}, options?.eState);
          } else {
            const saved = owner.settings.markdownStates[file.path];
            await original.call(this, file, {...options, state: {...saved, ...options?.state}});
          }
        } finally {
          owner.navigating.delete(this);
          owner.observeMarkdownModes();
          owner.syncActions();
        }
      });
    };
    WorkspaceLeaf.prototype.openFile = wrapped;
    this.register(() => {
      // Leave wrappers installed by other plugins intact; this one becomes inert.
      if (WorkspaceLeaf.prototype.openFile === wrapped) WorkspaceLeaf.prototype.openFile = original;
    });
  }

  private applicationViews(): ApplicationView[] {
    return this.app.workspace.getLeavesOfType(VIEW).flatMap(leaf => leaf.view instanceof ApplicationView ? [leaf.view] : []);
  }

  private updateViews(path?: string) {
    for (const view of this.applicationViews()) {
      if (view.path === path) view.scheduleRefresh();
    }
  }

  async sourceText(file: TFile) {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file?.path === file.path && active.getMode() === 'source') return active.editor.getValue();
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path && leaf.view.getMode() === 'source') return leaf.view.editor.getValue();
    }
    return this.app.vault.read(file);
  }

  private resolveTargetLeaf(evt: MouseEvent, currentLeaf: WorkspaceLeaf): WorkspaceLeaf {
    if (evt.button === 1 || Keymap.isModEvent(evt)) {
      if (evt.altKey) return this.app.workspace.getLeaf('split');
      return this.app.workspace.getLeaf('tab');
    }
    return currentLeaf;
  }

  async openApplication(file: TFile, evt?: MouseEvent, fromLeaf?: WorkspaceLeaf, targetOffset?: number) {
    const activeLeaf = fromLeaf ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf ?? this.app.workspace.getLeaf(false);
    const targetLeaf = evt ? this.resolveTargetLeaf(evt, activeLeaf) : activeLeaf;
    this.rememberMarkdown(activeLeaf);
    return this.queueFor(targetLeaf).run(async () => {
      if (this.stopped || !targetLeaf.parent) return;
      this.navigating.add(targetLeaf);
      try {
        const parsed = parseRanges(await this.sourceText(file));
        if (!parsed.ranges.length && !parsed.errors.length) {
          new Notice(`当前笔记没有${this.settings.viewName}内容，请先加入范围。`);
          await targetLeaf.setViewState({type: 'markdown', state: {file: file.path, ...this.settings.markdownStates[file.path]}, active: true});
          return;
        }
        this.settings.noteStates[file.path] = 'app';
        await this.saveSettings();
        if (this.stopped || !targetLeaf.parent) return;
        await targetLeaf.setViewState({type: VIEW, state: {file: file.path, targetOffset}, active: true});
      } finally {
        this.navigating.delete(targetLeaf);
        this.observeMarkdownModes();
        this.syncActions();
      }
    });
  }

  async jumpToSource(path: string, offset: number, fromLeaf?: WorkspaceLeaf) {
    await this.openSource(path, undefined, fromLeaf);
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active && active.file?.path === path) {
      if (active.getMode() !== 'source') {
        await this.applyMarkdownModeWhenReady(active.leaf, path, { mode: 'source', source: false });
      }
      const pos = active.editor.offsetToPos(offset);
      active.editor.setCursor(pos);
      active.editor.scrollIntoView({ from: pos, to: pos }, true);
      active.editor.focus();
    }
  }

  async editSource(file: TFile, expected: string | undefined, operation: (text: string) => string): Promise<boolean> {
    const checked = (text: string) => {
      if (expected !== undefined && text !== expected) throw new Error('正文已更新，本次操作未写入。请等待刷新后重试。');
      return operation(text);
    };
    try {
      const view = this.app.workspace.getLeavesOfType('markdown').map(l => l.view).find(v => v instanceof MarkdownView && v.file === file && v.getMode() === 'source');
      if (view instanceof MarkdownView) {
        const before = view.editor.getValue();
        const after = checked(before);
        let from = 0;
        while (from < before.length && from < after.length && before[from] === after[from]) from++;
        let end = before.length, newEnd = after.length;
        while (end > from && newEnd > from && before[end-1] === after[newEnd-1]) {end--; newEnd--;}
        if (before !== after) view.editor.replaceRange(after.slice(from,newEnd),view.editor.offsetToPos(from),view.editor.offsetToPos(end),'app-view.edit');
      } else await this.app.vault.process(file, checked);
      this.updateViews(file.path);
      return true;
    } catch (error) {
      new Notice(error instanceof Error ? error.message : '无法修改源笔记。');
      this.updateViews(file.path);
      return false;
    }
  }

  private addNamedCommand(command: Command) {
    const label = command.name.replace(this.settings.viewName, '{name}');
    this.namedCommands.push({command: this.addCommand(command), label});
  }

  refreshName() {
    for (const {command, label} of this.namedCommands) command.name = `${this.manifest.name}: ${label.replace('{name}', this.settings.viewName)}`;
    this.ribbonEl?.setAttribute('aria-label', `详细版／${this.settings.viewName}`);
    for (const action of this.leafActions.values()) action.showEl.setAttribute('aria-label', `左键：查看${this.settings.viewName} | 右键：调整范围`);
    for (const view of this.applicationViews()) view.updateName();
    this.decorations.refresh();
    if (this.editing) {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view) this.mountFloatingBar(view);
    }
  }

  refreshBlockGap() {
    for (const view of this.applicationViews()) {
      view.contentEl.toggleClass('has-block-gap', this.settings.blankLineBetweenBlocks);
    }
  }

  async removeRangeAt(path: string, rangeFrom: number, rangeTo: number, expected?: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const changed = await this.editSource(file, expected, text => {
      const edit = removeSpecificRangeEdit(text, rangeFrom, rangeTo);
      return text.slice(0, edit.from) + edit.text + text.slice(edit.to);
    });
    if (changed) new Notice(`已从${this.settings.viewName}移除该段。`);
  }

  async clearAllRangesInFile(file: TFile) {
    if (await this.editSource(file, undefined, clearRangeMarkers)) new Notice(`已清空所有${this.settings.viewName}标记。`);
  }

  async openSource(path: string, evt?: MouseEvent, fromLeaf?: WorkspaceLeaf) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) { new Notice('源笔记不存在。'); return; }
    const activeLeaf = fromLeaf ?? this.app.workspace.getActiveViewOfType(ApplicationView)?.leaf ?? this.app.workspace.getLeaf(false);
    const targetLeaf = evt ? this.resolveTargetLeaf(evt, activeLeaf) : activeLeaf;
    return this.queueFor(targetLeaf).run(async () => {
      if (this.stopped || !targetLeaf.parent) return;
      this.navigating.add(targetLeaf);
      try {
        this.settings.noteStates[file.path] = 'detail';
        await this.saveSettings();
        if (this.stopped || !targetLeaf.parent) return;
        const saved = this.settings.markdownStates[file.path] ?? {mode: 'preview', source: false};
        await targetLeaf.setViewState({type: 'markdown', state: {file: file.path, ...saved}, active: true});
      } finally {
        this.navigating.delete(targetLeaf);
        this.observeMarkdownModes();
        this.syncActions();
      }
    });
  }

  async applyMarkdownModeWhenReady(leaf: WorkspaceLeaf, filePath: string, state: MarkdownState): Promise<void> {
    await this.queueFor(leaf).run(async () => {
      if (this.stopped || !(leaf.view instanceof MarkdownView) || leaf.view.file?.path !== filePath) return;
      await leaf.setViewState({type: 'markdown', state: {file: filePath, ...state}});
      this.rememberMarkdown(leaf);
    });
  }

  private apply(editor: Editor, operation: () => TextEdit) {
    try {
      const edit = operation();
      editor.replaceRange(edit.text, editor.offsetToPos(edit.from), editor.offsetToPos(edit.to),'app-view.range');
    } catch (error) { new Notice(error instanceof Error ? error.message : '无法修改范围。'); }
  }

  private include(editor: Editor) {
    this.apply(editor, () => addRangeEdit(editor.getValue(), editor.posToOffset(editor.getCursor('from')), editor.posToOffset(editor.getCursor('to'))));
    this.updateFloatingBar();
  }

  includeRange(editor: Editor, from: number, to: number) {
    this.apply(editor, () => addRangeEdit(editor.getValue(), from, to));
    this.updateFloatingBar();
  }

  private exclude(editor: Editor) {
    this.apply(editor, () => removeRangeEdit(editor.getValue(), editor.posToOffset(editor.getCursor())));
    this.updateFloatingBar();
  }

  toggleRanges() {
    this.editing = !this.editing;
    this.decorations.refresh();
    if (this.editing) {
      const active = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (active) this.mountFloatingBar(active);
    } else {
      this.unmountFloatingBar();
    }
  }

  private clearAllRanges(view: MarkdownView) {
    const editor = view.editor;
    const content = editor.getValue();
    const cleaned = clearRangeMarkers(content);
    if (cleaned !== content) {
      editor.replaceRange(cleaned, {line: 0, ch: 0}, editor.offsetToPos(content.length),'app-view.clear');
      new Notice(`已清除当前笔记所有${this.settings.viewName}标记（按 Ctrl+Z 可撤销）。`);
      this.updateFloatingBar();
    } else {
      new Notice(`当前笔记未包含${this.settings.viewName}标记。`);
    }
  }

  private syncActions() {
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    const leafSet = new Set(leaves);
    for (const [leaf, action] of this.leafActions) {
      if (!leafSet.has(leaf)) {
        action.cleanup();
        this.leafActions.delete(leaf);
      }
    }
    for (const leaf of leaves) {
      if (this.leafActions.has(leaf)) continue;
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;

      const showEl = view.addAction('zap', `左键：查看${this.settings.viewName} | 右键：调整范围`, (evt: MouseEvent) => {
        if (view.file) {
          const cursorOffset = view.getMode() === 'source' ? view.editor.posToOffset(view.editor.getCursor()) : undefined;
          void this.openApplication(view.file, evt, leaf, cursorOffset);
        }
      });
      showEl.addClass('app-view-toggle');

      const onContextMenu = (evt: MouseEvent) => {
        evt.preventDefault();
        evt.stopPropagation();
        this.toggleRanges();
      };

      showEl.addEventListener('contextmenu', onContextMenu);

      this.leafActions.set(leaf, {
        showEl,
        cleanup: () => {
          showEl.removeEventListener('contextmenu', onContextMenu);
          showEl.remove();
        }
      });
    }
  }

  private mountFloatingBar(view: MarkdownView) {
    this.unmountFloatingBar();
    const bar = view.containerEl.createDiv({ cls: 'app-view-floating-bar' });
    bar.createSpan({ cls: 'app-view-floating-label', text: `${this.settings.viewName}调整中` });
    const countEl = bar.createSpan({ cls: 'app-view-floating-count' });

    const include = bar.createEl('button', { cls: 'app-view-floating-btn', text: '加入选区' });
    const exclude = bar.createEl('button', { cls: 'app-view-floating-btn', text: '取消范围' });
    const done = bar.createEl('button', { cls: 'app-view-floating-btn mod-cta', text: '完成调整 (Esc)' });

    for (const btn of [include, exclude]) {
      btn.addEventListener('mousedown', e => e.preventDefault());
    }
    include.addEventListener('click', () => this.include(view.editor));
    exclude.addEventListener('click', () => this.exclude(view.editor));
    done.addEventListener('click', () => this.toggleRanges());

    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.toggleRanges();
      }
    };
    view.containerEl.ownerDocument.addEventListener('keydown', onKeydown);

    this.floatingBar = {
      el: bar,
      countEl,
      cleanup: () => {
        view.containerEl.ownerDocument.removeEventListener('keydown', onKeydown);
        bar.remove();
      }
    };
    this.updateFloatingBar();
  }

  private unmountFloatingBar() {
    if (this.floatingBar) {
      this.floatingBar.cleanup();
      this.floatingBar = undefined;
    }
  }

  private updateFloatingBar() {
    if (!this.floatingBar || !this.editing) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const text = view.editor.getValue();
    const parsed = parseRanges(text);
    this.floatingBar.countEl.setText(`已选 ${parsed.ranges.length} 段`);
  }

  private updateFloatingBarHost() {
    if (!this.editing) return;
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) {
      if (this.floatingBar?.el.parentElement !== active.containerEl) {
        this.mountFloatingBar(active);
      } else {
        this.updateFloatingBar();
      }
    } else {
      this.unmountFloatingBar();
    }
  }

  onunload() {
    this.stopped = true;
    this.unmountFloatingBar();
    for (const action of this.leafActions.values()) {
      action.cleanup();
    }
    this.leafActions.clear();
  }
}

class ApplicationSettingTab extends PluginSettingTab {
  constructor(app: App, readonly plugin: ApplicationPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('视图名称')
      .setDesc('在顶栏、右键菜单和命令面板中显示的称呼（如：速查版、精要版、实践版）')
      .addText(text => text
        .setPlaceholder('速查版')
        .setValue(this.plugin.settings.viewName)
        .onChange(async value => {
          this.plugin.settings.viewName = value.trim() || '速查版';
          await this.plugin.saveSettings();
          this.plugin.refreshName();
        }));

    new Setting(containerEl)
      .setName('块间空行')
      .setDesc('在速查版的内容块之间默认保留一个空行间距')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.blankLineBetweenBlocks)
        .onChange(async value => {
          this.plugin.settings.blankLineBetweenBlocks = value;
          await this.plugin.saveSettings();
          this.plugin.refreshBlockGap();
        }));
  }
}

