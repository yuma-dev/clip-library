#!/usr/bin/env node
// Convert a completed asset render's PNG frames without recapturing its UI.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, execFileSync} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import {transparentAnimationBackground} from './asset-pipeline/webp.mjs';
import {flatten} from './asset-pipeline/codecs.mjs';
import {animationBounds} from './asset-pipeline/crop.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [sourceArg,outArg,limitArg='10000000',edgeArg='1280',backgroundArg='transparent',cropArg='full',profile='standard']=process.argv.slice(2);
if(!['standard','smooth','markdown','presentation'].includes(profile))throw Error('Unknown WebP profile');
const background=backgroundArg==='transparent'?null:backgroundArg;
if(background!==null&&!/^#[a-f\d]{6}$/i.test(background))throw Error('Background must be transparent or #RRGGBB');
if(!['full','crop'].includes(cropArg)&&!/^\d+,\d+,\d+,\d+$/.test(cropArg))throw Error('Framing must be full, crop, or x,y,width,height');
if(!sourceArg || !outArg)throw Error('Usage: node scripts/asset-webp.mjs <render-directory> <new-output-directory> [max-bytes] [max-edge] [background] [full|crop|x,y,width,height] [standard|smooth|markdown|presentation]');
const source=path.resolve(sourceArg), out=path.resolve(outArg), limit=Number(limitArg);
const maxEdge=Number(edgeArg);
if(!Number.isSafeInteger(maxEdge)||maxEdge<64)throw Error('max-edge must be an integer >= 64');
if(!Number.isSafeInteger(limit)||limit<100000)throw Error('max-bytes must be an integer >= 100000');
const base=await fs.realpath(path.join(root,'export-out'));
const lexical=path.relative(path.join(root,'export-out'),out);
if(!lexical || lexical.startsWith('..')||path.isAbsolute(lexical))throw Error('Output must remain inside export-out');
let ancestor=path.dirname(out);
while(true){try{await fs.access(ancestor);break;}catch(error){if(error.code!=='ENOENT')throw error;ancestor=path.dirname(ancestor);}}
const ancestorRel=path.relative(base,await fs.realpath(ancestor));
if(ancestorRel.startsWith('..')||path.isAbsolute(ancestorRel))throw Error('Output junction leaves export-out');
await fs.mkdir(path.dirname(out),{recursive:true});
const parent=await fs.realpath(path.dirname(out));
const rel=path.relative(base,parent);
if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('Output must remain inside export-out');
execFileSync('git',['check-ignore','-q','--no-index',out],{cwd:root});
await fs.mkdir(out); // Refuse to replace any existing delivery.
const manifest=JSON.parse(await fs.readFile(path.join(source,'manifest.json'),'utf8'));
if(manifest.status!=='complete')throw Error('Source render is incomplete');
const frames=manifest.outputs.find(o=>o.layer==='transparent'&&o.format==='frames');
if(!frames)throw Error('Source needs transparent PNG frames');
const candidate=path.join(out,'candidate.webp');
const attempts=[];
const input=path.resolve(source,frames.file);
const manual=cropArg.includes(',')?cropArg.split(',').map(Number):null;
const crop=manual?{x:manual[0],y:manual[1],width:manual[2],height:manual[3]}:cropArg==='crop'?await animationBounds(input,manifest.fps,manifest.width,manifest.height):{x:0,y:0,width:manifest.width,height:manifest.height};
if(crop.width<1||crop.height<1||crop.x+crop.width>manifest.width||crop.y+crop.height>manifest.height)throw Error('Crop exceeds source canvas');
console.log(JSON.stringify({crop,background}));
// Sharing copies cap the canvas; keep source motion before lowering frame rate.
const baseScale=Math.min(1,maxEdge/Math.max(crop.width,crop.height));
const settings=profile==='presentation'?[95,90,85].map(quality=>({quality,lossless:0,fps:Math.min(30,manifest.fps),scale:1})):profile==='markdown'?[15,12,10,8].map(fps=>({quality:80,lossless:1,fps:Math.min(fps,manifest.fps),scale:1})):profile==='smooth'?[...[1,0.833333,0.666667].map(scale=>({quality:80,lossless:1,fps:Math.min(20,manifest.fps),scale})),...[0.666667,0.533333,0.4].map(scale=>({quality:80,lossless:1,fps:Math.min(15,manifest.fps),scale}))]:[... [80,65,50,35].map(quality=>({quality,fps:manifest.fps,scale:1})),
  ...[24,20,15].map(fps=>({quality:50,fps:Math.min(fps,manifest.fps),scale:1})),
  ...[0.85,0.7,0.5].map(scale=>({quality:50,fps:Math.min(15,manifest.fps),scale}))];
for(const setting of settings){
  const width=Math.round(crop.width*baseScale*setting.scale),height=Math.round(crop.height*baseScale*setting.scale);
  console.log(JSON.stringify({source,attempt:setting,width,height}));
  await new Promise((resolve,reject)=>{
    const child=spawn(ffmpeg,['-y','-hide_banner','-loglevel','error','-framerate',String(manifest.fps),'-i',path.resolve(source,frames.file),
      '-vf',`fps=${setting.fps},crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=${width}:${height}:flags=lanczos,${background?flatten(background)+',':''}format=bgra`,
      '-c:v','libwebp_anim','-lossless',String(setting.lossless??0),'-quality',String(setting.quality),'-compression_level','4','-loop','0',candidate],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    let error='';child.stderr.on('data',chunk=>error=(error+chunk).slice(-4000));child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(error)));
  });
  const bytes=(await fs.stat(candidate)).size;
  attempts.push({...setting,width,height,bytes});
  console.log(JSON.stringify({bytes,limit}));
  if(bytes<limit){
    await fs.writeFile(candidate,transparentAnimationBackground(await fs.readFile(candidate),background));
    await fs.rename(candidate,path.join(out,'animation.webp'));
    await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify({source,format:'animated-webp',profile,alpha:background===null,background,crop,loop:0,duration:manifest.duration,maxBytes:limit,maxEdge,baseScale,...attempts.at(-1),file:'animation.webp',attempts},null,2));
    process.exit(0);
  }
}
await fs.unlink(candidate);
throw Error('Could not satisfy byte limit; no delivery was published');

