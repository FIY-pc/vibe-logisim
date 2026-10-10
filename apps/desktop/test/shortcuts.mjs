import assert from 'node:assert/strict';
import {test} from 'node:test';
import {defaultBindings,eventBinding,bindingLabel,bindingProblem,resolveBindings,bindingOverrides} from '../circuit-lens/web/core/shortcuts.js';

test('bindings round-trip swaps and explicit clearing without retaining the old shortcut',()=>{
  const edited=resolveBindings({select:'2',wire:'1',poke:null});
  assert.equal(edited.select,'2');assert.equal(edited.wire,'1');assert.equal(edited.poke,null);
  assert.deepEqual(resolveBindings(bindingOverrides(edited)),edited);
  assert.deepEqual(bindingOverrides({...defaultBindings}),{});
});

test('a conflict or fixed interaction cannot silently replace another action',()=>{
  assert.match(bindingProblem('wire','1',defaultBindings),/选择/);
  assert.match(bindingProblem('wire','Mod+,',defaultBindings),/快捷键设置/);
  assert.match(bindingProblem('wire','Mod+C',defaultBindings),/复制/);
  assert.match(bindingProblem('wire','Shift+Enter',defaultBindings),/保留/);
  assert.equal(bindingProblem('wire','W',defaultBindings),null);
  assert.throws(()=>resolveBindings({wire:'1'}),/选择/);
  assert.throws(()=>resolveBindings({wire:'bad'}),/不支持/);
  assert.throws(()=>resolveBindings([]),/格式/);
});

test('keyboard layout, numpad and modifier matching remain explicit',()=>{
  assert.equal(eventBinding({key:'1',code:'Numpad1'}),'1');
  assert.equal(eventBinding({key:'!',code:'Digit1',shiftKey:true}),'Shift+1');
  assert.equal(eventBinding({key:'A',code:'KeyA',shiftKey:true}),'Shift+A');
  assert.equal(eventBinding({key:'s',ctrlKey:true}),'Mod+S');
  assert.equal(eventBinding({key:'s',metaKey:true},true),'Mod+S');
  assert.equal(eventBinding({key:'∫',code:'KeyB',metaKey:true,altKey:true},true),'Mod+Alt+B');
  assert.equal(bindingLabel('Mod+Alt+B',true),'⌘+⌥+B');
  assert.equal(eventBinding({key:',',code:'Comma',ctrlKey:true}),'Mod+,');
});

test('IME, dead keys and AltGraph never turn text entry into shortcuts',()=>{
  assert.equal(eventBinding({key:'1',code:'Digit1',isComposing:true}),null);
  assert.equal(eventBinding({key:'1',keyCode:229}),null);
  assert.equal(eventBinding({key:'Dead'}),null);
  assert.equal(eventBinding({key:'q',ctrlKey:true,altKey:true,getModifierState:()=>true}),null);
});
