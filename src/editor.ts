import { StateEffect, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, ViewUpdate, WidgetType, type DecorationSet } from '@codemirror/view';
import { editorLivePreviewField } from 'obsidian';
import { parseRanges } from './ranges';

const refresh = StateEffect.define<null>();

class MarkerBadge extends WidgetType {
  readonly label: string;
  constructor(label: string) {
    super();
    this.label = label;
  }
  toDOM(view: EditorView): HTMLElement {
    const badge = view.dom.ownerDocument.createElement('span');
    badge.className = 'app-view-marker-badge';
    badge.textContent = this.label;
    return badge;
  }
  eq(other: MarkerBadge): boolean {
    return this.label === other.label;
  }
}

export function rangeExtension(
  isEditing: () => boolean,
  getViewName: () => string = () => '速查版'
): { extension: Extension; refresh: () => void } {
  const editors = new Set<EditorView>();

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      atomic: DecorationSet = Decoration.none;
      parsed: ReturnType<typeof parseRanges>;
      readonly view: EditorView;

      constructor(view: EditorView) {
        this.view = view;
        editors.add(view);
        this.parsed = parseRanges(view.state.doc.toString());
        this.rebuild();
      }

      update(update: ViewUpdate) {
        if (update.docChanged) {
          this.parsed = parseRanges(update.state.doc.toString());
        }
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.transactions.some(t => t.effects.some(e => e.is(refresh)))
        ) {
          this.rebuild();
        }
      }

      rebuild() {
        if (!this.view.state.field(editorLivePreviewField, false)) {
          this.decorations = Decoration.none;
          this.atomic = Decoration.none;
          return;
        }

        const editing = isEditing();

        // When not editing and no errors, hide markers completely using line class and in-line replacement.
        if (!editing && !this.parsed.errors.length) {
          const replacements = [];
          for (const marker of this.parsed.markers) {
            // Line decoration to hide the entire line height and layout
            replacements.push(
              Decoration.line({
                class: 'app-view-marker-hidden'
              }).range(marker.from)
            );
            // Replace the marker text atomically within the line
            replacements.push(
              Decoration.replace({}).range(marker.from, marker.to)
            );
          }
          this.decorations = Decoration.set(replacements, true);
          this.atomic = this.decorations;
          return;
        }

        // When editing or when there are range errors, replace comment text with clean badge (no raw comment shown).
        const name = getViewName();
        const decorations = [];
        const atomicReplacements = [];

        for (const marker of this.parsed.markers) {
          const isError = this.parsed.errors.length > 0;
          decorations.push(
            Decoration.line({
              class: isError ? 'app-view-marker-error' : 'app-view-marker-edit'
            }).range(marker.from)
          );
          const replaceDeco = Decoration.replace({
            widget: new MarkerBadge(marker.kind === 'start' ? `${name}开始` : `${name}结束`)
          }).range(marker.from, marker.to);
          decorations.push(replaceDeco);
          atomicReplacements.push(replaceDeco);
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
        this.atomic = Decoration.set(atomicReplacements, true);
      }

      destroy() {
        editors.delete(this.view);
      }
    },
    { decorations: v => v.decorations }
  );

  const atomicFacet = EditorView.atomicRanges.of(view => {
    return view.plugin(plugin)?.atomic ?? Decoration.none;
  });

  return {
    extension: [plugin, atomicFacet],
    refresh: () => {
      for (const editor of editors) {
        editor.dispatch({ effects: refresh.of(null) });
      }
    }
  };
}
