import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRanges,
  addRangeEdit,
  removeRangeEdit,
  removeSpecificRangeEdit,
  detectBlockAt,
  toggleCheckboxInSource,
  clearRangeMarkers,
  type TextEdit
} from '../src/ranges';
const apply = (text: string, edit: TextEdit) => text.slice(0, edit.from) + edit.text + text.slice(edit.to);

test('clearing markers preserves code examples, inline literals, blank lines and CRLF', () => {
  const source='Before\r\n\r\n%%app%%\r\n\r\nText\r\n\r\n%%/app%%\r\n```md\r\n%%app%%\r\nexample\r\n%%/app%%\r\n```\r\ninline %%app%% remains';
  assert.equal(clearRangeMarkers(source),'Before\r\n\r\n\r\nText\r\n\r\n```md\r\n%%app%%\r\nexample\r\n%%/app%%\r\n```\r\ninline %%app%% remains');
});
test('task indexing ignores fenced examples and supports ordered and quoted tasks', () => {
  const source='%%app%%\n```md\n- [ ] example\n```\n1. [ ] ordered\n> - [ ] quoted\n- [ ] plain\n%%/app%%';
  assert.equal(toggleCheckboxInSource(source,0,0),source.replace('1. [ ]','1. [x]'));
  assert.equal(toggleCheckboxInSource(source,0,1),source.replace('> - [ ]','> - [x]'));
  assert.equal(toggleCheckboxInSource(source,0,2),source.replace('- [ ] plain','- [x] plain'));
});
test('code block detection from closing fence and heading-like code includes the whole block', () => {
  const source='before\n```md\n# fake heading\n- example\n```\nafter';
  for (const offset of [source.indexOf('# fake'),source.lastIndexOf('```')]) {
    const block=detectBlockAt(source,offset)!;
    assert.equal(source.slice(block.from,block.to),'```md\n# fake heading\n- example\n```\n');
  }
});

test('collects headings, multi-line lists and paragraphs in source order', () => {
  const source = '背景\n%%app%%\n## 步骤\n\n- 一\n  - 子项\n\n两行\n正文\n%%/app%%\n说明\n%%app%%\n最后\n%%/app%%';
  const parsed = parseRanges(source);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.ranges.map(r => r.text), ['## 步骤\n\n- 一\n  - 子项\n\n两行\n正文\n', '最后\n']);
});
test('malformed markers never silently extend a range', () => {
  for (const text of ['%%app%%\n正文', '%%/app%%', '%%app%%\n%%app%%\nx\n%%/app%%']) assert.ok(parseRanges(text).errors.length);
});
test('ignores fenced code, YAML, indentation, quotations and comments', () => {
  const source = '---\n%%app%%\n---\n````md\n%%app%%\n```\n%%/app%%\n````\n~~~\n%%app%%\n~~~\n    %%app%%\n> %%app%%\n%%\n%%app%%\n%%/app%%\n%%\n<!--\n%%app%%\n-->\n';
  assert.deepEqual(parseRanges(source).markers, []);
});
test('CRLF is preserved while adding and removing ranges', () => {
  const text = '背景\r\n标题\r\n正文\r\n尾部\r\n';
  const wrapped = apply(text, addRangeEdit(text, 4, 10));
  assert.equal(wrapped, '背景\r\n%%app%%\r\n标题\r\n正文\r\n%%/app%%\r\n尾部\r\n');
  assert.equal(apply(wrapped, removeRangeEdit(wrapped, wrapped.indexOf('正文'))), text);
});
test('selection ending at next line start does not include that line', () => {
  const text = 'first\nsecond\nthird';
  const wrapped = apply(text, addRangeEdit(text, 0, 6));
  assert.deepEqual(parseRanges(wrapped).ranges.map(r => r.text), ['first\n']);
  assert.ok(wrapped.endsWith('second\nthird'));
});
test('rejects partial words, overlapping and empty selections', () => {
  assert.throws(() => addRangeEdit('abcdef', 1, 3));
  assert.throws(() => addRangeEdit('abcdef', 0, 0));
  const text = '%%app%%\nabcdef\n%%/app%%';
  assert.throws(() => addRangeEdit(text, 8, 14));
});
test('rejects partial fenced code but accepts a complete fence', () => {
  const source = '```js\nconst a = 1;\n```\n';
  assert.throws(() => addRangeEdit(source, 0, 5));
  assert.throws(() => addRangeEdit(source, 6, 18));
  const result = parseRanges(apply(source, addRangeEdit(source, 0, source.length)));
  assert.equal(result.ranges[0].text, source);
});
test('adjacent ranges remain distinct and cancel preserves the inner text', () => {
  const source = '%%app%%\n- a\n%%/app%%\n%%app%%\n- b\n%%/app%%\n';
  assert.equal(parseRanges(source).ranges.length, 2);
  const result = apply(source, removeRangeEdit(source, 9));
  assert.ok(result.startsWith('- a\n%%app%%'));
  assert.equal(parseRanges(result).ranges.length, 1);
});
test('plain and empty notes have an empty application', () => {
  for (const text of ['', 'plain', '%%app%%\n%%/app%%']) assert.deepEqual(parseRanges(text).errors, []);
  assert.equal(parseRanges('plain').ranges.length, 0);
});
test('a complete range remains valid at EOF without final newline', () => {
  const result = parseRanges(apply('正文', addRangeEdit('正文', 0, 2)));
  assert.deepEqual(result.errors, []);
  assert.equal(result.ranges.length, 1);
});

test('detectBlockAt detects heading hierarchy and stops before existing markers', () => {
  const doc = '# 顶层标题\n引言\n%%app%%\n## 二级标题\n内容1\n%%/app%%\n## 另一个二级\n';
  // 1. Detect H1 above marker: stops before %%app%%
  const h1Block = detectBlockAt(doc, doc.indexOf('# 顶层标题'));
  assert.ok(h1Block);
  assert.equal(h1Block.label, '当前章节');
  assert.equal(h1Block.isEnclosed, false);
  assert.equal(doc.slice(h1Block.from, h1Block.to), '# 顶层标题\n引言\n');

  // 2. Cursor inside existing range (on heading): isEnclosed is true
  const h2Block = detectBlockAt(doc, doc.indexOf('## 二级标题'));
  assert.ok(h2Block);
  assert.equal(h2Block.isEnclosed, true);

  // 3. Cursor inside existing range (on content): isEnclosed is true
  const contentBlock = detectBlockAt(doc, doc.indexOf('内容1'));
  assert.ok(contentBlock);
  assert.equal(contentBlock.isEnclosed, true);
});

test('detectBlockAt detects nested lists and callouts', () => {
  const doc = '- 父项\n  - 子项1\n  - 子项2\n- 另一个父项\n\n> [!note]\n> 引用第一行\n> 引用第二行\n\n普通段落';
  const listBlock = detectBlockAt(doc, doc.indexOf('父项'));
  assert.ok(listBlock);
  assert.equal(doc.slice(listBlock.from, listBlock.to), '- 父项\n  - 子项1\n  - 子项2\n');

  const calloutBlock = detectBlockAt(doc, doc.indexOf('引用第一行'));
  assert.ok(calloutBlock);
  assert.equal(doc.slice(calloutBlock.from, calloutBlock.to), '> [!note]\n> 引用第一行\n> 引用第二行\n');
});

test('toggleCheckboxInSource toggles between unchecked and checked', () => {
  const doc = '前言\n%%app%%\n- [ ] 待办一\n- [x] 待办二\n%%/app%%\n后记';
  const updated1 = toggleCheckboxInSource(doc, 0, 0);
  assert.ok(updated1);
  assert.ok(updated1.includes('- [x] 待办一'));

  const updated2 = toggleCheckboxInSource(doc, 0, 1);
  assert.ok(updated2);
  assert.ok(updated2.includes('- [ ] 待办二'));
});

test('removeSpecificRangeEdit removes target range by bounds', () => {
  const doc = '%%app%%\n段落一\n%%/app%%\n%%app%%\n段落二\n%%/app%%';
  const parsed = parseRanges(doc);
  const r2 = parsed.ranges[1];
  const edit = removeSpecificRangeEdit(doc, r2.from, r2.to);
  const result = apply(doc, edit);
  assert.equal(parseRanges(result).ranges.length, 1);
  assert.ok(!result.includes('%%app%%\n段落二'));
});

test('detectBlockAt includes full code fences even if they contain marker-like text', () => {
  const doc = '## 自己试一试\n\n文字说明\n\n```markdown\n%%app%%\n代码示例\n%%/app%%\n```\n';
  const block = detectBlockAt(doc, doc.indexOf('## 自己试一试'));
  assert.ok(block);
  assert.equal(block.label, '当前章节');
  assert.equal(doc.slice(block.from, block.to), doc);

  // Adding this range must not throw '选区截断了代码块或注释'
  const edit = addRangeEdit(doc, block.from, block.to);
  const result = apply(doc, edit);
  const parsed = parseRanges(result);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.ranges.length, 1);
});
