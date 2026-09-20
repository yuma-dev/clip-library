import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import ffmpeg from 'ffmpeg-static';
import { encodingArguments } from './codecs.mjs';

test('VP9 roundtrip retains clear pixels and the full soft alpha ramp', async () => {
  const base=path.resolve('export-out');
  await fs.mkdir(base,{recursive:true});
  const out=await fs.mkdtemp(path.join(base,'alpha-test-'));
  const browser=await chromium.launch();
  try {
    const page=await browser.newPage();
    const png=await page.evaluate(()=>{
      const c=document.createElement('canvas');c.width=256;c.height=32;
      const ctx=c.getContext('2d'),data=ctx.createImageData(256,32);
      for(let y=0;y<32;y++)for(let x=0;x<256;x++){
        const p=(y*256+x)*4;data.data.set([220,80,30,x],p);
      }
      ctx.putImageData(data,0,0);return c.toDataURL().split(',')[1];
    });
    await fs.writeFile(path.join(out,'source.png'),Buffer.from(png,'base64'));
    execFileSync(ffmpeg,['-v','error','-i',path.join(out,'source.png'),...encodingArguments('webm'),'-frames:v','1',path.join(out,'alpha.webm')],{windowsHide:true});
    const decoded=execFileSync(ffmpeg,['-v','error','-c:v','libvpx-vp9','-i',path.join(out,'alpha.webm'),'-frames:v','1','-pix_fmt','rgba','-f','rawvideo','-'],{windowsHide:true});
    assert.equal(decoded.length,256*32*4);
    for(let y=0;y<32;y++)for(let x=0;x<256;x++){
      const actual=decoded[(y*256+x)*4+3];
      // FFmpeg's pixel-format conversion can round an intermediate alpha by one.
      if(x===0||x===255)assert.equal(actual,x);
      else assert.ok(Math.abs(actual-x)<=1,`alpha at ${x},${y}: ${actual}`);
    }
  } finally {
    await browser.close();
    const relative=path.relative(base,path.resolve(out));
    if(relative && !relative.startsWith('..') && !path.isAbsolute(relative))await fs.rm(out,{recursive:true,force:true});
  }
});
