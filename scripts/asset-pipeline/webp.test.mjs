import {test} from 'node:test';
import assert from 'node:assert/strict';
import {transparentAnimationBackground} from './webp.mjs';
test('WebP background correction preserves loop count and encoded frame bytes',()=>{
  const source=Buffer.from('524946461e00000057454250414e494d06000000ffffffff0300565038200400000012345678','hex');
  const fixed=transparentAnimationBackground(source);
  assert.equal(fixed.length,source.length);
  assert.deepEqual(fixed.subarray(20,24),Buffer.alloc(4));
  assert.deepEqual(fixed.subarray(24),source.subarray(24));
  assert.equal(source.readUInt32LE(20),0xffffffff);
  assert.deepEqual(transparentAnimationBackground(fixed),fixed);
  const opaque=transparentAnimationBackground(source,'#050608');
  assert.equal(opaque.readUInt32LE(20),0xff050608);
  assert.deepEqual(opaque.subarray(24),source.subarray(24));
  assert.throws(()=>transparentAnimationBackground(source.subarray(0,25)),/Invalid/);
});
