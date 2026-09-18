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
        if (open) result.errors.push(`第 ${line.number} 行：速查范围不能嵌套。`);
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
  if (open) result.errors.push(`第 ${open.number} 行：速查范围没有结束标记。`);
  return result;
}

export interface TextEdit { from: number; to: number; text: string }

export function addRangeEdit(text: string, from: number, to: number): TextEdit {
  if (from === to) throw new Error('请先选中要加入速查版的完整段落或内容块。');
  const parsed = parseRanges(text);
  if (parsed.errors.length) throw new Error(parsed.errors[0]);
  const lines = linesOf(text);
  const first = lines.find(l => from >= l.from && from < l.end) ?? lines[lines.length - 1];
  const last = lines.find(l => to - 1 >= l.from && to - 1 < l.end) ?? first;
  if (text.slice(first.from, from).trim() || text.slice(to, last.to).trim()) {
    throw new Error('请选中完整行；速查范围不截取一句话中的几个字。');
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
  if (!range) throw new Error('请把光标放在需要取消的速查范围内。');
  return { from: range.start.from, to: range.end.end, text: range.text };
}

export function removeSpecificRangeEdit(text: string, rangeFrom: number, rangeTo: number): TextEdit {
  const parsed = parseRanges(text);
  if (parsed.errors.length) throw new Error(parsed.errors[0]);
  const range = parsed.ranges.find(r => r.from === rangeFrom && r.to === rangeTo)
    ?? parsed.ranges.find(r => rangeFrom >= r.start.from && rangeTo <= r.end.end);
  if (!range) throw new Error('未找到要移除的标记范围。');
  return { from: range.start.from, to: range.end.end, text: range.text };
}

export interface DetectedBlock {
  from: number;
  to: number;
  label: string;
  isEnclosed: boolean;
}

export function detectBlockAt(text: string, offset: number): DetectedBlock | undefined {
  const lines = linesOf(text);
  if (lines.length === 0) return undefined;
  const parsed = parseRanges(text);

  // 1. If cursor is anywhere inside an existing range (heading, paragraph, list, empty line inside range, etc.)
  const enclosingRange = parsed.ranges.find(r =>
    (offset >= r.from && offset <= r.to) ||
    (offset >= r.start.from && offset <= r.end.end)
  );
  if (enclosingRange) {
    return { from: enclosingRange.start.from, to: enclosingRange.end.end, label: '速查范围', isEnclosed: true };
  }

  let curIdx = lines.findIndex(l => offset >= l.from && offset <= l.to);
  if (curIdx === -1) {
    if (offset >= text.length && lines.length > 0) curIdx = lines.length - 1;
    else return undefined;
  }

  const curLine = lines[curIdx];
  if (!curLine.text.trim()) return undefined;

  // Ignore genuine marker lines or YAML frontmatter lines
  if (parsed.markers.some(m => m.number === curLine.number)) return undefined;
  if (parsed.protectedLines.has(curLine.number) && !/^ {0,3}(`{3,}|~{3,})/.test(curLine.text)) {
    if (lines[0]?.text.replace(/^\uFEFF/, '') === '---') {
      const secondFence = lines.slice(1).findIndex(l => /^(---|\.\.\.)\s*$/.test(l.text));
      if (secondFence !== -1 && curIdx <= secondFence + 1) return undefined;
    }
  }

  let startIdx = curIdx;
  let endIdx = curIdx;
  let label = '当前段落';

  // 1. Heading (stops before existing markers or next heading of same/higher level, tracks code fences)
  const headingMatch = /^(#{1,6})[ \t]+/.exec(curLine.text);
  if (headingMatch) {
    const level = headingMatch[1].length;
    label = '当前章节';
    endIdx = lines.length - 1;
    let inFence: { char: string; size: number } | undefined;

    for (let i = curIdx + 1; i < lines.length; i++) {
      const line = lines[i];

      // If inside code fence, never break inside it
      if (inFence) {
        const close = /^ {0,3}(`+|~+)\s*$/.exec(line.text);
        if (close && close[1][0] === inFence.char && close[1].length >= inFence.size) {
          inFence = undefined;
        }
        continue;
      }
      const openFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
      if (openFence && !(openFence[1][0] === '`' && openFence[2].includes('`'))) {
        inFence = { char: openFence[1][0], size: openFence[1].length };
        continue;
      }

      // Check genuine markers or ranges
      const isRealMarker = parsed.markers.some(m => m.number === line.number);
      const isInsideRange = parsed.ranges.some(r => line.from >= r.start.from && line.to <= r.end.end);
      if (isRealMarker || isInsideRange) {
        endIdx = i - 1;
        break;
      }

      // Check next heading of same or higher level
      const nextHeading = /^(#{1,6})[ \t]+/.exec(line.text);
      if (nextHeading && nextHeading[1].length <= level) {
        endIdx = i - 1;
        break;
      }
    }
    if (endIdx < curIdx) endIdx = curIdx;
  }
  // 2. Fenced Code Block
  else if (parsed.protectedLines.has(curLine.number) || /^ {0,3}(`{3,}|~{3,})/.test(curLine.text)) {
    let openFenceIdx = -1;
    let fenceChar = '';
    let fenceSize = 0;
    for (let i = curIdx; i >= 0; i--) {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i].text);
      if (m) {
        openFenceIdx = i;
        fenceChar = m[1][0];
        fenceSize = m[1].length;
        break;
      }
    }
    if (openFenceIdx !== -1) {
      startIdx = openFenceIdx;
      label = '当前代码块';
      endIdx = lines.length - 1;
      for (let i = openFenceIdx + 1; i < lines.length; i++) {
        const close = /^ {0,3}(`+|~+)\s*$/.exec(lines[i].text);
        if (close && close[1][0] === fenceChar && close[1].length >= fenceSize) {
          endIdx = i;
          break;
        }
      }
    }
  }
  // 3. Table
  else if (curLine.text.trim().startsWith('|') && curLine.text.trim().endsWith('|')) {
    label = '当前表格';
    while (startIdx > 0 && lines[startIdx - 1].text.trim().startsWith('|') && lines[startIdx - 1].text.trim().endsWith('|')) {
      startIdx--;
    }
    while (endIdx < lines.length - 1 && lines[endIdx + 1].text.trim().startsWith('|') && lines[endIdx + 1].text.trim().endsWith('|')) {
      endIdx++;
    }
  }
  // 4. Callout / Blockquote
  else if (/^ {0,3}>/.test(curLine.text)) {
    label = '当前引用块';
    while (startIdx > 0 && /^ {0,3}>/.test(lines[startIdx - 1].text)) {
      startIdx--;
    }
    while (endIdx < lines.length - 1 && /^ {0,3}>/.test(lines[endIdx + 1].text)) {
      endIdx++;
    }
  }
  // 5. List item (including nested children)
  else if (/^(\s*)([-*+]|\d+\.)\s+/.test(curLine.text)) {
    const match = /^(\s*)([-*+]|\d+\.)\s+/.exec(curLine.text)!;
    const baseIndent = match[1].length;
    label = '当前列表项';
    for (let i = curIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (parsed.markers.some(m => m.number === line.number)) break;
      if (!line.text.trim()) {
        let hasDeeperAhead = false;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].text.trim()) {
            const nextIndent = /^\s*/.exec(lines[j].text)?.[0].length ?? 0;
            if (nextIndent > baseIndent) hasDeeperAhead = true;
            break;
          }
        }
        if (hasDeeperAhead) continue;
        else break;
      }
      const nextIndent = /^\s*/.exec(line.text)?.[0].length ?? 0;
      if (nextIndent > baseIndent) {
        endIdx = i;
      } else {
        break;
      }
    }
  }
  // 6. Normal Paragraph
  else {
    label = '当前段落';
    const isBoundaryLine = (l: Line) =>
      !l.text.trim() ||
      parsed.markers.some(m => m.number === l.number) ||
      parsed.protectedLines.has(l.number) ||
      /^#{1,6}[ \t]+/.test(l.text) ||
      /^ {0,3}>/.test(l.text) ||
      (l.text.trim().startsWith('|') && l.text.trim().endsWith('|')) ||
      /^(\s*)([-*+]|\d+\.)\s+/.test(l.text) ||
      /^ {0,3}(`{3,}|~{3,})/.test(l.text);

    while (startIdx > 0 && !isBoundaryLine(lines[startIdx - 1])) {
      startIdx--;
    }
    while (endIdx < lines.length - 1 && !isBoundaryLine(lines[endIdx + 1])) {
      endIdx++;
    }
  }

  while (endIdx > startIdx && !lines[endIdx].text.trim()) {
    endIdx--;
  }

  const from = lines[startIdx].from;
  const to = lines[endIdx].end;

  return { from, to, label, isEnclosed: false };
}

export function toggleCheckboxInSource(sourceText: string, rangeIndex: number, checkboxIndex: number): string | undefined {
  const parsed = parseRanges(sourceText);
  if (rangeIndex < 0 || rangeIndex >= parsed.ranges.length) return undefined;
  const range = parsed.ranges[rangeIndex];
  const regex = /^(\s*[-*+]\s+\[)([ xX])(\])/gm;
  let count = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(range.text)) !== null) {
    if (count === checkboxIndex) {
      const currentVal = match[2];
      const newVal = currentVal === ' ' ? 'x' : ' ';
      const matchPosInText = range.from + match.index + match[1].length;
      return sourceText.slice(0, matchPosInText) + newVal + sourceText.slice(matchPosInText + 1);
    }
    count++;
  }
  return undefined;
}

