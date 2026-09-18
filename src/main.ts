import { Component, ItemView, Keymap, MarkdownRenderer, MarkdownView, Notice, Plugin, TFile, type Editor, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import { rangeExtension } from './editor';
import { addRangeEdit, parseRanges, removeRangeEdit, type TextEdit } from './ranges';

const VIEW = 'app-view';

class ApplicationView extends ItemView {
  path = '';
  private generation = 0;
  private rendered?: Component;
  private lastText?: string;
  private heading!: HTMLElement;
  private status!: HTMLElement;
  private body!: HTMLElement;
  private timer?: number;
  private timerWindow?: Window;
  constructor(leaf: WorkspaceLeaf, private readonly owner: ApplicationPlugin) { super(leaf); }
  getViewType() { return VIEW; }
  getDisplayText() { return this.path ? `${this.path.split('/').pop()?.replace(/\.md$/, '')} · 应用版` : '应用版'; }
  getIcon() { return 'list-checks'; }
  getState() { return { path: this.path }; }
  async setState(state: unknown, result: ViewStateResult) {
    if (state && typeof state === 'object' && 'path' in state && typeof state.path === 'string') this.path = state.path;
    this.lastText = undefined;
    await super.setState(state, result);
    await this.refresh();
  }
  async onOpen() {
    this.contentEl.addClass('app-view-container');
    const bar = this.contentEl.createDiv({ cls: 'app-view-toolbar' });
    this.heading = bar.createEl('span', { cls: 'app-view-title', text: '应用版' });
    const back = bar.createEl('button', { text: '返回详细版' });
    this.registerDomEvent(back, 'click', () => { void this.owner.openSource(this.path); });
    this.status = this.contentEl.createDiv({ cls: 'app-view-status', attr: { 'aria-live': 'polite' } });
    this.body = this.contentEl.createDiv({ cls: 'app-view-body markdown-rendered' });
    // A projection is read-only, including task checkboxes and editable embeds.
    this.registerDomEvent(this.body, 'click', (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target?.instanceOf(Element) && target.closest('input, textarea, select, [contenteditable="true"]')) {
        event.preventDefault(); event.stopImmediatePropagation();
        return;
      }
      const link = target?.instanceOf(Element) ? target.closest('a.internal-link') : null;
      const href = link?.getAttribute('data-href') ?? link?.getAttribute('href');
      if (href) {
        event.preventDefault(); event.stopPropagation();
        void this.app.workspace.openLinkText(href, this.path, Keymap.isModEvent(event));
      }
    }, { capture: true });
    await this.refresh();
  }
  scheduleRefresh() {
    this.clearTimer();
    this.timerWindow = this.contentEl.ownerDocument.defaultView ?? undefined;
    this.timer = this.timerWindow?.setTimeout(() => { this.timer = undefined; void this.refresh(); }, 180);
  }
  private clearTimer() { if (this.timer !== undefined) this.timerWindow?.clearTimeout(this.timer); this.timer = undefined; }
  async refresh() {
    if (!this.body) return;
    const generation = ++this.generation;
    const file = this.app.vault.getAbstractFileByPath(this.path);
    this.heading.setText(file instanceof TFile ? `${file.basename} · 应用版` : '应用版');
    if (!(file instanceof TFile)) {
      this.lastText = undefined; this.disposeRendering(); this.body.empty();
      this.status.setText('源笔记不存在。请从详细版重新打开应用版。'); return;
    }
    let text: string;
    try { text = await this.owner.sourceText(file); }
    catch { if (generation === this.generation) this.status.setText('暂时无法读取源笔记，请稍后重新打开。'); return; }
    if (generation !== this.generation || this.lastText === text) return;
    const parsed = parseRanges(text);
    if (parsed.errors.length) {
      this.lastText = undefined; this.disposeRendering(); this.body.empty();
      this.status.setText(`范围需要修正：${parsed.errors.join(' ')} 返回详细版并打开“调整应用范围”即可修改。`); return;
    }
    const staging = this.body.ownerDocument.createDocumentFragment().createDiv();
    const component = new Component();
    this.addChild(component);
    try {
      // Separate sections prevent unrelated lists, tables and code blocks from merging.
      for (const range of parsed.ranges) {
        if (!range.text.trim()) continue;
        const section = staging.createEl('section', { cls: 'app-view-section' });
        await MarkdownRenderer.render(this.app, range.text, section, file.path, component);
        if (generation !== this.generation) { this.removeChild(component); return; }
      }
      for (const checkbox of Array.from(staging.querySelectorAll<HTMLInputElement>('input'))) checkbox.disabled = true;
      for (const editable of Array.from(staging.querySelectorAll<HTMLElement>('[contenteditable]'))) editable.setAttribute('contenteditable', 'false');
      const scroll = this.contentEl.scrollTop;
      this.disposeRendering();
      this.rendered = component;
      this.body.replaceChildren(...Array.from(staging.childNodes));
      this.lastText = text;
      this.status.setText(parsed.ranges.length ? `${parsed.ranges.length} 个范围 · 随详细版自动更新 · 只读` : '还没有应用内容。在详细版中选中文字，然后选择“加入应用版”。');
      this.contentEl.scrollTop = scroll;
    } catch {
      this.removeChild(component);
      if (generation === this.generation) this.status.setText('内容渲染失败，请返回详细版检查内容后重试。');
    }
  }
  private disposeRendering() { if (this.rendered) this.removeChild(this.rendered); this.rendered = undefined; }
  async onClose() { this.generation++; this.clearTimer(); this.disposeRendering(); }
}

export default class ApplicationPlugin extends Plugin {
  private editing = false;
  private decorations = rangeExtension(() => this.editing);
  private bars = new Map<MarkdownView, { el: HTMLElement; toggle: HTMLButtonElement; lifecycle: Component }>();

  onload() {
    this.registerView(VIEW, leaf => new ApplicationView(leaf, this));
    this.registerEditorExtension(this.decorations.extension);
    this.addCommand({ id: 'show-application', name: '查看应用版', checkCallback: checking => {
      const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
      if (!file) return false;
      if (!checking) void this.openApplication(file);
      return true;
    } });
    this.addCommand({ id: 'toggle-ranges', name: '显示／隐藏应用范围', callback: () => this.toggleRanges() });
    this.addCommand({ id: 'include-selection', name: '加入应用版', editorCallback: editor => this.include(editor) });
    this.addCommand({ id: 'exclude-range', name: '取消当前应用范围', editorCallback: editor => this.exclude(editor) });
    this.addRibbonIcon('list-checks', '详细版／应用版', () => {
      const view = this.app.workspace.getActiveViewOfType(ApplicationView);
      if (view) void this.openSource(view.path);
      else {
        const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (file) void this.openApplication(file);
        else new Notice('请先打开一篇详细笔记。');
      }
    });
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor) => {
      menu.addItem(item => item.setTitle('加入应用版').setIcon('plus').onClick(() => this.include(editor)));
      menu.addItem(item => item.setTitle('取消当前应用范围').setIcon('minus').onClick(() => this.exclude(editor)));
    }));
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'md') menu.addItem(item => item.setTitle('查看应用版').setIcon('list-checks').onClick(() => this.openApplication(file)));
    }));
    this.registerEvent(this.app.workspace.on('editor-change', (_editor, info) => this.updateViews(info.file?.path)));
    this.registerEvent(this.app.vault.on('modify', file => this.updateViews(file.path)));
    this.registerEvent(this.app.vault.on('delete', file => this.updateViews(file.path)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      for (const view of this.applicationViews()) {
        if (view.path === oldPath) view.path = file.path;
        else if (view.path.startsWith(oldPath + '/')) view.path = file.path + view.path.slice(oldPath.length);
        view.scheduleRefresh();
      }
      this.app.workspace.requestSaveLayout();
    }));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.syncBars()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.syncBars()));
    this.app.workspace.onLayoutReady(() => this.syncBars());
  }
  private applicationViews(): ApplicationView[] {
    return this.app.workspace.getLeavesOfType(VIEW).flatMap(leaf => leaf.view instanceof ApplicationView ? [leaf.view] : []);
  }
  private updateViews(path?: string) { for (const view of this.applicationViews()) if (view.path === path) view.scheduleRefresh(); }
  async sourceText(file: TFile) {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file?.path === file.path && active.getMode() === 'source') return active.editor.getValue();
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path && leaf.view.getMode() === 'source') return leaf.view.editor.getValue();
    }
    return this.app.vault.read(file);
  }
  async openApplication(file: TFile) {
    const leaf = this.app.workspace.getLeavesOfType(VIEW)[0] ?? this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW, state: { path: file.path }, active: true });
    await this.app.workspace.revealLeaf(leaf);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }
  async openSource(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) { new Notice('源笔记不存在。'); return; }
    const existing = this.app.workspace.getLeavesOfType('markdown').find(l => l.view instanceof MarkdownView && l.view.file?.path === path);
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      this.app.workspace.setActiveLeaf(existing, { focus: true });
    }
    else await this.app.workspace.getLeaf('tab').openFile(file, { state: { mode: 'source', source: false } });
  }
  private apply(editor: Editor, operation: () => TextEdit) {
    try {
      const edit = operation();
      editor.replaceRange(edit.text, editor.offsetToPos(edit.from), editor.offsetToPos(edit.to));
    } catch (error) { new Notice(error instanceof Error ? error.message : '无法修改范围。'); }
  }
  private include(editor: Editor) {
    this.apply(editor, () => addRangeEdit(editor.getValue(), editor.posToOffset(editor.getCursor('from')), editor.posToOffset(editor.getCursor('to'))));
  }
  private exclude(editor: Editor) {
    this.apply(editor, () => removeRangeEdit(editor.getValue(), editor.posToOffset(editor.getCursor())));
  }
  private toggleRanges() {
    this.editing = !this.editing;
    this.decorations.refresh();
    for (const { el, toggle } of this.bars.values()) {
      toggle.setText(this.editing ? '完成范围调整' : '调整应用范围');
      toggle.setAttribute('aria-pressed', String(this.editing));
      el.toggleClass('app-view-is-adjusting', this.editing);
    }
  }
  private syncBars() {
    const views = new Set(this.app.workspace.getLeavesOfType('markdown').flatMap(l => l.view instanceof MarkdownView ? [l.view] : []));
    for (const [view, bar] of this.bars) if (!views.has(view)) { this.removeChild(bar.lifecycle); this.bars.delete(view); }
    for (const view of views) {
      if (this.bars.has(view)) continue;
      const lifecycle = new Component();
      this.addChild(lifecycle);
      view.contentEl.addClass('app-view-source-container');
      lifecycle.register(() => view.contentEl.removeClass('app-view-source-container'));
      const el = view.contentEl.createDiv({ cls: 'app-view-source-toolbar' });
      view.contentEl.prepend(el);
      lifecycle.register(() => el.remove());
      const show = el.createEl('button', { text: '查看应用版' });
      const toggle = el.createEl('button', { text: this.editing ? '完成范围调整' : '调整应用范围', attr: { 'aria-pressed': String(this.editing) } });
      const include = el.createEl('button', { cls: 'app-view-adjust-action', text: '加入选区' });
      const exclude = el.createEl('button', { cls: 'app-view-adjust-action', text: '取消范围' });
      el.toggleClass('app-view-is-adjusting', this.editing);
      lifecycle.registerDomEvent(show, 'click', () => { if (view.file) void this.openApplication(view.file); });
      lifecycle.registerDomEvent(toggle, 'click', () => this.toggleRanges());
      // Preserve the editor selection when a toolbar button is clicked.
      for (const button of [include, exclude]) lifecycle.registerDomEvent(button, 'mousedown', event => event.preventDefault());
      lifecycle.registerDomEvent(include, 'click', () => this.include(view.editor));
      lifecycle.registerDomEvent(exclude, 'click', () => this.exclude(view.editor));
      this.bars.set(view, { el, toggle, lifecycle });
    }
  }
  onunload() { this.bars.clear(); }
}
