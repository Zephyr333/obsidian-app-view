import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRanges, addRangeEdit, removeRangeEdit, type TextEdit } from '../src/ranges';
const apply = (text: string, edit: TextEdit) => text.slice(0, edit.from) + edit.text + text.slice(edit.to);

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
