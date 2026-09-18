import { StateEffect } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, ViewUpdate, WidgetType, type DecorationSet } from '@codemirror/view';
import { editorLivePreviewField } from 'obsidian';
import { parseRanges } from './ranges';

const refresh = StateEffect.define<null>();

class QuietBoundary extends WidgetType {
  toDOM(view: EditorView): HTMLElement {
    const span = view.dom.ownerDocument.createDocumentFragment().createSpan();
    span.className = 'app-view-boundary';
    span.setAttribute('aria-label', '应用范围边界');
    span.textContent = '·';
    return span;
  }
}

export function rangeExtension(isEditing: () => boolean) {
  const editors = new Set<EditorView>();
  const extension = ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;
    parsed: ReturnType<typeof parseRanges>;
    constructor(readonly view: EditorView) {
      editors.add(view);
      this.parsed = parseRanges(view.state.doc.toString());
      this.rebuild();
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.parsed = parseRanges(update.state.doc.toString());
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.transactions.some(t => t.effects.some(e => e.is(refresh)))) this.rebuild();
    }
    rebuild() {
      if (!this.view.state.field(editorLivePreviewField, false)) { this.decorations = Decoration.none; return; }
      const decorations = [];
      const editing = isEditing();
      for (const marker of this.parsed.markers) {
        if (!this.view.visibleRanges.some(r => marker.from <= r.to && marker.to >= r.from)) continue;
        const selected = this.view.state.selection.ranges.some(r => r.from <= marker.to && r.to >= marker.from);
        decorations.push(Decoration.line({ class: editing || this.parsed.errors.length ? 'app-view-marker-edit' : 'app-view-marker-quiet' }).range(marker.from));
        // Never hide text under the cursor or a selection. Keep the line break intact.
        if (!editing && !selected && !this.parsed.errors.length) {
          decorations.push(Decoration.replace({ widget: new QuietBoundary() }).range(marker.from, marker.to));
        }
      }
      if (editing && !this.parsed.errors.length) {
        for (const visible of this.view.visibleRanges) {
          let line = this.view.state.doc.lineAt(visible.from);
          while (line.from <= visible.to) {
            if (this.parsed.ranges.some(r => line.from >= r.from && line.from < r.to)) {
              decorations.push(Decoration.line({ class: 'app-view-selected-line' }).range(line.from));
            }
            if (line.number === this.view.state.doc.lines) break;
            line = this.view.state.doc.line(line.number + 1);
          }
        }
      }
      this.decorations = Decoration.set(decorations, true);
    }
    destroy() { editors.delete(this.view); }
  }, { decorations: v => v.decorations });
  return { extension, refresh: () => { for (const editor of editors) editor.dispatch({ effects: refresh.of(null) }); } };
}
