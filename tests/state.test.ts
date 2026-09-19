import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPreferences, remapPreferences, SerialQueue} from '../src/state';

test('per-note choices and detailed modes survive a JSON persistence roundtrip', () => {
  const state=loadPreferences(null);
  state.noteStates['A.md']='app';
  state.noteStates['B.md']='detail';
  state.markdownStates['B.md']={mode:'source',source:true};
  assert.deepEqual(loadPreferences(JSON.parse(JSON.stringify(state))),state);
  assert.equal(loadPreferences(null).noteStates['A.md'],undefined);
});
test('old data is migrated and corrupt fields do not break navigation', () => {
  assert.deepEqual(loadPreferences({viewName:'应用版',noteStates:null,markdownStates:[]}),loadPreferences(null));
  const state=loadPreferences({noteStates:{'A.md':'app','B.md':false},markdownStates:{'A.md':{mode:'preview',source:true},'B.md':{mode:'invalid'}}});
  assert.deepEqual(state.noteStates,{'A.md':'app'});
  assert.deepEqual(state.markdownStates,{'A.md':{mode:'preview',source:false}});
});
test('folder rename and deletion migrate descendants but not similarly named folders', () => {
  const state=loadPreferences({noteStates:{'A/x.md':'app','AB/x.md':'detail'},markdownStates:{'A/x.md':{mode:'source',source:true}}});
  remapPreferences(state,'A','Moved');
  assert.equal(state.noteStates['Moved/x.md'],'app');
  assert.equal(state.noteStates['AB/x.md'],'detail');
  assert.equal(state.markdownStates['Moved/x.md'].source,true);
  remapPreferences(state,'Moved');
  assert.deepEqual(state.noteStates,{'AB/x.md':'detail'});
});
test('delayed navigation and writes finish in request order; failures do not poison the queue', async () => {
  const queue=new SerialQueue(); const order:string[]=[];
  let release!:()=>void;
  const gate=new Promise<void>(r=>release=r);
  const first=queue.run(async()=>{order.push('A:start'); await gate; order.push('A:end');});
  const second=queue.run(async()=>{order.push('B'); throw Error('test');});
  const rejected=assert.rejects(second,/test/);
  const third=queue.run(async()=>{order.push('A:last');});
  await Promise.resolve(); assert.deepEqual(order,['A:start']);
  release(); await Promise.all([first,rejected,third]);
  assert.deepEqual(order,['A:start','A:end','B','A:last']);
});
