import {spawn} from 'node:child_process';
import { ffmpegPath as ffmpeg } from '../../main/ffmpeg-binaries.js';

// Union of every frame's nonzero-alpha bounds; includes transient UI and glows.
export async function animationBounds(input,fps,width,height){
  let left=width,top=height,right=-1,bottom=-1,pending='',tail='';
  await new Promise((resolve,reject)=>{
    const child=spawn(ffmpeg,['-hide_banner','-nostats','-framerate',String(fps),'-i',input,'-vf','alphaextract,bbox=min_val=0','-an','-f','null','-'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    function line(text){
      const match=text.match(/x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)/);
      if(!match)return;
      const [,x1,x2,y1,y2]=match.map(Number);
      if(x2<x1||y2<y1)return;
      left=Math.min(left,x1);right=Math.max(right,x2);top=Math.min(top,y1);bottom=Math.max(bottom,y2);
    }
    child.stderr.on('data',chunk=>{tail=(tail+chunk).slice(-2000);pending+=chunk;const lines=pending.split(/\r?\n/);pending=lines.pop();lines.forEach(line);});
    child.on('error',reject);child.on('close',code=>{line(pending);code===0?resolve():reject(Error(tail));});
  });
  if(right<left||bottom<top)throw Error('No visible animation bounds');
  const pad=8,x=Math.max(0,left-pad),y=Math.max(0,top-pad);
  return {x,y,width:Math.min(width,right+pad+1)-x,height:Math.min(height,bottom+pad+1)-y,padding:pad,alphaThreshold:0};
}
