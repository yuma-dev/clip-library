import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { validate, localOutput } from './contract.mjs';
import { preset, presets } from './presets.mjs';
import { decodeCursor, cursorPng } from './xcursor.mjs';

const source = fs.readFileSync(new URL('../../src/renderer/export/timeline.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { sample, frameSpec } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('all starter recipes satisfy the contract', () => {
  for (const name of presets) validate(preset(name, '/demo.svg'));
});
test('seek backwards reproduces state without mutating fixture', () => {
  const spec = preset('clip-tag', '/demo.svg');
  assert.deepEqual(frameSpec(spec, 4).fixtures[0].clip.tags, ['Highlight']);
  assert.deepEqual(frameSpec(spec, 0).fixtures[0].clip.tags, []);
  assert.equal(frameSpec(spec, 2.5).props.menu, 'tags');
  assert.deepEqual(spec.fixtures[0].clip.tags, []);
});
test('trim duration changes continuously with an exact endpoint', () => {
  const spec = preset('player-trim', '/demo.svg');
  assert.equal(frameSpec(spec, 1.65).props.trimStart, 3);
  assert.equal(frameSpec(spec, 4.3).props.trimEnd, 22);
  assert.equal(frameSpec(spec, 5).props.trimStart, 6);
  assert.equal(sample([{ time: 0, value: 0 }, { time: 2, value: 10, easing: 'hold' }], 1), 0);
});
test('reject traversal, prototype mutation and unordered times', () => {
  const spec = preset('player-trim', '/demo.svg');
  spec.timeline.tracks[0].path = 'props.__proto__.polluted';
  assert.throws(() => validate(spec), /unsafe track/);
  spec.timeline.tracks[0].path = 'props.trimStart';
  spec.timeline.tracks[0].keys[1].time = 0;
  assert.throws(() => validate(spec), /increase/);
  assert.throws(() => localOutput(process.cwd(), path.resolve('export-out/../public')), /output/);
  const bad = preset('clip-tag', '/demo.svg'); bad.layers['../bad'] = null;
  assert.throws(() => validate(bad), /unsafe layer/);
});

test('discrete profile states and stepped sliders survive arbitrary seeking', () => {
  const spec = { scene:'settings', fixtures:[], timeline:{ duration:2, tracks:[
    { path:'props.blur', step:10, keys:[{time:0,value:80},{time:2,value:110,easing:'linear'}] },
    { path:'props.person', keys:[{time:0,value:-1},{time:1,value:0,easing:'hold'},{time:2,value:1,easing:'hold'}] }
  ] } };
  validate(spec);
  assert.equal(frameSpec(spec,1.5).props.blur,100);
  assert.equal(frameSpec(spec,1.5).props.person,0);
  assert.equal(frameSpec(spec,0.5).props.person,-1);
});

test('Xcursor preserves hotspots and unpremultiplies edge pixels', () => {
  const bytes=Buffer.alloc(68);
  for (const [offset,value] of [[0,0x72756358],[4,16],[8,1],[12,1],[16,0xfffd0002],[20,48],[24,28],[28,36],[32,0xfffd0002],[36,48],[40,1],[44,1],[48,1],[52,0],[56,0],[60,0],[64,0x80402010]]) bytes.writeUInt32LE(value,offset);
  const result=decodeCursor(bytes);
  assert.deepEqual([result.width,result.height,result.hotX,result.hotY],[1,1,0,0]);
  assert.deepEqual([...result.rgba],[128,64,32,128]);
  assert.deepEqual([...cursorPng(result).subarray(0,8)],[137,80,78,71,13,10,26,10]);
});

test('solid source requires a real six-digit color', () => {
  const spec={scene:'videoPlayer',fixtures:[],media:{kind:'color',color:'#33aa55'}};
  validate(spec);
  spec.media.color='red';
  assert.throws(()=>validate(spec),/media/);
});
