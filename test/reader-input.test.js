import test from 'node:test';
import assert from 'node:assert/strict';
import {openRangedAudioSource} from '../src/index.js';
import {waveFile,asFile} from './helpers/media-fixtures.js';
test('invalid ranges and cancelled reads fail before allocating PCM', async()=>{
  const source=await openRangedAudioSource(asFile(waveFile({channels:2,frames:100})));
  await assert.rejects(source.read(0,-1),RangeError);
  await assert.rejects(source.read(0,NaN),RangeError);
  const control=new AbortController();control.abort();
  await assert.rejects(source.read(0,10,control.signal),{name:'AbortError'});
  await source.close();
  await source.close();
  await assert.rejects(source.read(0,10),/closed/);
});
