import {
  App,
  Component,
  ItemView,
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
  type ViewStateResult,
  type WorkspaceLeaf
} from 'obsidian';
import { rangeExtension } from './editor';
import {
  addRangeEdit,
  detectBlockAt,
  parseRanges,
  removeRangeEdit,
  removeSpecificRangeEdit,
  toggleCheckboxInSource,
  type TextEdit
} from './ranges';

const VIEW = 'app-view';

export interface PluginSettings {
  viewName: string;
  noteStates: Record<string, 'detail' | 'app'>;
}

const DEFAULT_SETTINGS: PluginSettings = {
  viewName: '速查版',
  noteStates: {}
};

class ApplicationView extends ItemView {
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
  private floatingBar?: { el: HTMLElement; cleanup: () => void };

  constructor(leaf: WorkspaceLeaf, private readonly owner: ApplicationPlugin) {
    super(leaf);
    const backActionEl = this.addAction('file-text', '左键：返回详细版 | 右键：管理速查版', (evt: MouseEvent) => {
      void this.owner.openSource(this.path, evt, this.leaf);
    });
    backActionEl.addEventListener('contextmenu', (evt: MouseEvent) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.toggleManaging();
    });
  }

  getViewType() { return VIEW; }
  getDisplayText() {
    const file = this.app.vault.getAbstractFileByPath(this.path);
    return file instanceof TFile ? file.basename : (this.path ? this.path.split('/').pop()?.replace(/\.md$/, '') ?? '' : this.owner.settings.viewName);
  }
  getIcon() { return 'zap'; }
  getState() { return { path: this.path }; }
  async setState(state: unknown, result: ViewStateResult) {
    if (state && typeof state === 'object' && 'path' in state && typeof state.path === 'string') this.path = state.path;
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

    this.heading = this.contentEl.createEl('div', { cls: 'inline-title' });
    this.body = this.contentEl.createDiv({ cls: 'app-view-body' });

    this.registerDomEvent(this.body, 'click', async (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      // 1. Task Checkbox toggle and write back to source
      if (target instanceof HTMLInputElement && target.type === 'checkbox') {
        const section = target.closest<HTMLElement>('.app-view-section');
        if (!section) return;
        const rangeIndex = parseInt(section.dataset.rangeIndex ?? '-1', 10);
        if (rangeIndex === -1) return;

        const allCheckboxes = Array.from(section.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
        const checkboxIndex = allCheckboxes.indexOf(target);
        if (checkboxIndex === -1) return;

        const file = this.app.vault.getAbstractFileByPath(this.path);
        if (file instanceof TFile) {
          await this.app.vault.process(file, content => {
            const updated = toggleCheckboxInSource(content, rangeIndex, checkboxIndex);
            return updated ?? content;
          });
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
            void this.owner.removeRangeAt(this.path, range.from, range.to);
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

          await MarkdownRenderer.render(this.app, range.text, section, file.path, component);
          if (generation !== this.generation) { this.removeChild(component); return; }
        }
        for (const editable of Array.from(staging.querySelectorAll<HTMLElement>('[contenteditable]'))) editable.setAttribute('contenteditable', 'false');
      }

      const scroll = this.contentEl.scrollTop;
      this.disposeRendering();
      this.rendered = component;
      this.body.replaceChildren(...Array.from(staging.childNodes));
      this.lastText = text;

      // Scroll to target offset if requested
      if (this.targetScrollOffset !== undefined) {
        const targetOffset = this.targetScrollOffset;
        this.targetScrollOffset = undefined;
        const sections = Array.from(this.body.querySelectorAll<HTMLElement>('.app-view-section'));
        const match = sections.find(s => {
          const from = parseInt(s.dataset.from ?? '0', 10);
          const to = parseInt(s.dataset.to ?? '0', 10);
          return targetOffset >= from && targetOffset <= to;
        }) ?? sections[0];
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

  private disposeRendering() { if (this.rendered) this.removeChild(this.rendered); this.rendered = undefined; }
  async onClose() { this.generation++; this.clearTimer(); this.unmountQuickViewFloatingBar(); this.disposeRendering(); }
}

export default class ApplicationPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  private editing = false;
  decorations = rangeExtension(
    () => this.editing,
    () => this.settings.viewName
  );
  private leafActions = new Map<WorkspaceLeaf, { showEl: HTMLElement; cleanup: () => void }>();
  private floatingBar?: { el: HTMLElement; countEl: HTMLElement; cleanup: () => void };

  isEditing() {
    return this.editing;
  }

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW, leaf => new ApplicationView(leaf, this));
    this.registerEditorExtension(this.decorations.extension);

    this.addSettingTab(new ApplicationSettingTab(this.app, this));

    this.addCommand({
      id: 'show-application',
      name: `查看${this.settings.viewName}`,
      checkCallback: checking => {
        const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (!file) return false;
        if (!checking) void this.openApplication(file);
        return true;
      }
    });

    this.addCommand({
      id: 'toggle-ranges',
      name: `显示／隐藏${this.settings.viewName}范围`,
      callback: () => this.toggleRanges()
    });

    this.addCommand({
      id: 'include-selection',
      name: `加入${this.settings.viewName}`,
      editorCallback: editor => this.include(editor)
    });

    this.addCommand({
      id: 'exclude-range',
      name: `取消当前${this.settings.viewName}范围`,
      editorCallback: editor => this.exclude(editor)
    });

    this.addCommand({
      id: 'clear-all-ranges',
      name: `清除当前笔记所有${this.settings.viewName}标记`,
      editorCallback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) this.clearAllRanges(view);
      }
    });

    this.addRibbonIcon('zap', `详细版／${this.settings.viewName}`, (evt: MouseEvent) => {
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
      delete this.settings.noteStates[file.path];
      void this.saveSettings();
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      for (const view of this.applicationViews()) {
        if (view.path === oldPath) view.path = file.path;
        else if (view.path.startsWith(oldPath + '/')) view.path = file.path + view.path.slice(oldPath.length);
        view.scheduleRefresh();
      }
      if (this.settings.noteStates[oldPath]) {
        this.settings.noteStates[file.path] = this.settings.noteStates[oldPath];
        delete this.settings.noteStates[oldPath];
        void this.saveSettings();
      }
      this.app.workspace.requestSaveLayout();
    }));

    // State persistence on opening notes
    this.registerEvent(this.app.workspace.on('file-open', async file => {
      if (!(file instanceof TFile) || file.extension !== 'md') return;

      const allLeaves = this.app.workspace.getLeavesOfType('markdown').concat(this.app.workspace.getLeavesOfType(VIEW));
      const leavesForFile = allLeaves.filter(leaf => {
        if (leaf.view instanceof MarkdownView) return leaf.view.file?.path === file.path;
        if (leaf.view instanceof ApplicationView) return leaf.view.path === file.path;
        return false;
      });

      // If more than 1 leaf exists for this file (e.g. split view or existing tabs), preserve layout
      if (leavesForFile.length > 1) return;

      if (this.settings.noteStates[file.path] === 'app') {
        const text = await this.sourceText(file);
        const parsed = parseRanges(text);
        if (parsed.ranges.length > 0) {
          const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf;
          if (activeLeaf && activeLeaf.view instanceof MarkdownView && activeLeaf.view.file?.path === file.path) {
            await activeLeaf.setViewState({ type: VIEW, state: { path: file.path }, active: true });
          }
        } else {
          this.settings.noteStates[file.path] = 'detail';
          await this.saveSettings();
        }
      }
    }));

    this.registerEvent(this.app.workspace.on('layout-change', () => this.syncActions()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      this.syncActions();
      this.updateFloatingBarHost();
      if (leaf?.view instanceof ApplicationView && leaf.view.path) {
        this.settings.noteStates[leaf.view.path] = 'app';
        void this.saveSettings();
      } else if (leaf?.view instanceof MarkdownView && leaf.view.file) {
        this.settings.noteStates[leaf.view.file.path] = 'detail';
        void this.saveSettings();
      }
    }));
    this.app.workspace.onLayoutReady(() => {
      this.syncActions();
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
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

    this.settings.noteStates[file.path] = 'app';
    await this.saveSettings();

    await targetLeaf.setViewState({
      type: VIEW,
      state: { path: file.path, targetOffset },
      active: true
    });
    await this.app.workspace.revealLeaf(targetLeaf);
    this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
  }

  async jumpToSource(path: string, offset: number, fromLeaf?: WorkspaceLeaf) {
    await this.openSource(path, undefined, fromLeaf);
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active && active.file?.path === path) {
      const pos = active.editor.offsetToPos(offset);
      active.editor.setCursor(pos);
      active.editor.scrollIntoView({ from: pos, to: pos }, true);
      active.editor.focus();
    }
  }

  async removeRangeAt(path: string, rangeFrom: number, rangeTo: number) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    await this.app.vault.process(file, text => {
      const edit = removeSpecificRangeEdit(text, rangeFrom, rangeTo);
      return text.slice(0, edit.from) + edit.text + text.slice(edit.to);
    });
    new Notice(`已从${this.settings.viewName}移除该段。`);
  }

  async clearAllRangesInFile(file: TFile) {
    await this.app.vault.process(file, text => {
      return text.replace(/%%app%%[\r\n]*/g, '').replace(/[\r\n]*%%\/app%%/g, '');
    });
    new Notice(`已清空所有${this.settings.viewName}标记。`);
  }

  async openSource(path: string, evt?: MouseEvent, fromLeaf?: WorkspaceLeaf) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) { new Notice('源笔记不存在。'); return; }

    const activeLeaf = fromLeaf ?? this.app.workspace.getActiveViewOfType(ApplicationView)?.leaf ?? this.app.workspace.getLeaf(false);
    const targetLeaf = evt ? this.resolveTargetLeaf(evt, activeLeaf) : activeLeaf;

    this.settings.noteStates[file.path] = 'detail';
    await this.saveSettings();

    await targetLeaf.setViewState({ type: 'markdown', state: { file: file.path, mode: 'source', source: false }, active: true });
    await this.app.workspace.revealLeaf(targetLeaf);
    this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
  }

  private apply(editor: Editor, operation: () => TextEdit) {
    try {
      const edit = operation();
      editor.replaceRange(edit.text, editor.offsetToPos(edit.from), editor.offsetToPos(edit.to));
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
    const cleaned = content.replace(/%%app%%[\r\n]*/g, '').replace(/[\r\n]*%%\/app%%/g, '');
    if (cleaned !== content) {
      editor.setValue(cleaned);
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
          const cursorOffset = view.editor.posToOffset(view.editor.getCursor());
          void this.openApplication(view.file, evt, leaf, cursorOffset);
        }
      });

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
    containerEl.createEl('h2', { text: `${this.plugin.settings.viewName}设置` });

    new Setting(containerEl)
      .setName('视图名称')
      .setDesc('在顶栏、右键菜单和命令面板中显示的称呼（如：速查版、精要版、实践版）')
      .addText(text => text
        .setPlaceholder('速查版')
        .setValue(this.plugin.settings.viewName)
        .onChange(async value => {
          this.plugin.settings.viewName = value.trim() || '速查版';
          await this.plugin.saveSettings();
          this.plugin.decorations.refresh();
        }));
  }
}


