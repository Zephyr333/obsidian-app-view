export const START = '%%app%%';
export const END = '%%/app%%';

export interface Line { text: string; from: number; to: number; end: number; number: number }
export interface Marker extends Line { kind: 'start' | 'end' }
export interface AppRange { start: Marker; end: Marker; from: number; to: number; text: string }
export interface ParsedRanges { ranges: AppRange[]; markers: Marker[]; errors: string[]; protectedLines: Set<number> }

export function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let from = 0;
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    lines.push({ text: line, from, to: from + line.length, end: Math.min(text.length, from + raw.length + 1), number: index + 1 });
    from += raw.length + 1;
  }
  return lines;
}

/** Markers are reserved only at column zero, outside YAML, code and other comments. */
export function parseRanges(text: string): ParsedRanges {
  const result: ParsedRanges = { ranges: [], markers: [], errors: [], protectedLines: new Set() };
  const lines = linesOf(text);
  let open: Marker | undefined;
  let fence: { char: string; size: number } | undefined;
  let yaml = false;
  let comment = false;
  let htmlComment = false;
  for (const line of lines) {
    const raw = line.text;
    if (line.number === 1 && raw.replace(/^\uFEFF/, '') === '---') {
      yaml = true; result.protectedLines.add(line.number); continue;
    }
    if (yaml) {
      result.protectedLines.add(line.number);
      if (/^(---|\.\.\.)\s*$/.test(raw)) yaml = false;
      continue;
    }
    if (fence) {
      result.protectedLines.add(line.number);
      const close = /^ {0,3}(`+|~+)\s*$/.exec(raw);
      if (close && close[1][0] === fence.char && close[1].length >= fence.size) fence = undefined;
      continue;
    }
    const fenceMatch = !comment && !htmlComment && /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
    if (fenceMatch && !(fenceMatch[1][0] === '`' && fenceMatch[2].includes('`'))) {
      fence = { char: fenceMatch[1][0], size: fenceMatch[1].length };
      result.protectedLines.add(line.number); continue;
    }
    const kind = !comment && !htmlComment && /^%%app%%[ \t]*$/.test(raw) ? 'start'
      : !comment && !htmlComment && /^%%\/app%%[ \t]*$/.test(raw) ? 'end' : undefined;
    if (kind) {
      const marker: Marker = { ...line, kind };
      result.markers.push(marker);
      if (kind === 'start') {
        if (open) result.errors.push(`第 ${line.number} 行：应用范围不能嵌套。`);
        else open = marker;
      } else if (!open) result.errors.push(`第 ${line.number} 行：结束标记缺少开始标记。`);
      else {
        result.ranges.push({ start: open, end: marker, from: open.end, to: marker.from, text: text.slice(open.end, marker.from) });
        open = undefined;
      }
      continue;
    }
    if (/^( {4}|\t)/.test(raw)) { result.protectedLines.add(line.number); continue; }
    // Ignore marker-like text inside multi-line comments; inline code cannot open comments.
    const withoutCode = raw.replace(/(`+)([^`]|(?!\1)`)*\1/g, '');
    if (comment || htmlComment) result.protectedLines.add(line.number);
    for (const token of withoutCode.match(/<!--|-->|%%/g) ?? []) {
      if (token === '<!--' && !comment) htmlComment = true;
      else if (token === '-->' && !comment) htmlComment = false;
      else if (token === '%%' && !htmlComment) comment = !comment;
    }
  }
  if (open) result.errors.push(`第 ${open.number} 行：应用范围没有结束标记。`);
  return result;
}

export interface TextEdit { from: number; to: number; text: string }

export function addRangeEdit(text: string, from: number, to: number): TextEdit {
  if (from === to) throw new Error('请先选中要加入应用版的完整段落或内容块。');
  const parsed = parseRanges(text);
  if (parsed.errors.length) throw new Error(parsed.errors[0]);
  const lines = linesOf(text);
  const first = lines.find(l => from >= l.from && from < l.end) ?? lines[lines.length - 1];
  const last = lines.find(l => to - 1 >= l.from && to - 1 < l.end) ?? first;
  if (text.slice(first.from, from).trim() || text.slice(to, last.to).trim()) {
    throw new Error('请选中完整行；应用范围不截取一句话中的几个字。');
  }
  if (parsed.protectedLines.has(first.number) && !/^ {0,3}(`{3,}|~{3,})/.test(first.text)) {
    throw new Error('请从完整内容块的开头选择，不要从代码块、属性或注释内部开始。');
  }
  if (parsed.markers.some(m => m.from < last.end && m.end > first.from)
    || parsed.ranges.some(r => first.from < r.end.end && last.end > r.start.from)) {
    throw new Error('选区与已有范围重叠，请先取消原范围或显示范围后调整边界。');
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = text.slice(first.from, last.end);
  const replacement = START + eol + body + (body.endsWith('\n') ? '' : eol) + END + (last.end < text.length || body.endsWith('\n') ? eol : '');
  const edit = { from: first.from, to: last.end, text: replacement };
  const candidate = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
  const checked = parseRanges(candidate);
  if (checked.errors.length || checked.ranges.length !== parsed.ranges.length + 1) {
    throw new Error('选区截断了代码块或注释，请选择完整内容块。');
  }
  return edit;
}

export function removeRangeEdit(text: string, offset: number): TextEdit {
  const parsed = parseRanges(text);
  if (parsed.errors.length) throw new Error(parsed.errors[0]);
  const range = parsed.ranges.find(r => offset >= r.start.from && offset <= r.end.to);
  if (!range) throw new Error('请把光标放在需要取消的应用范围内。');
  return { from: range.start.from, to: range.end.end, text: range.text };
}
