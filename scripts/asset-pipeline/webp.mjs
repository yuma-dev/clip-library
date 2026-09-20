// ANIM's BGRA background is separate from each frame's alpha channel.
export function transparentAnimationBackground(input, background=null) {
  const data=Buffer.from(input);
  if(data.toString('ascii',0,4)!=='RIFF'||data.toString('ascii',8,12)!=='WEBP'||data.readUInt32LE(4)+8!==data.length)throw Error('Invalid WebP container');
  let found=false;
  for(let offset=12;offset<data.length;){
    if(offset+8>data.length)throw Error('Truncated WebP chunk');
    const size=data.readUInt32LE(offset+4),end=offset+8+size;
    if(end>data.length)throw Error('Truncated WebP payload');
    if(data.toString('ascii',offset,offset+4)==='ANIM'){
      if(size!==6)throw Error('Invalid ANIM chunk');
      if(background===null)data.fill(0,offset+8,offset+12);
      else {
        if(!/^#[a-f\d]{6}$/i.test(background))throw Error('Invalid background color');
        data.writeUInt32LE((0xff000000+parseInt(background.slice(1),16))>>>0,offset+8);
      }
      found=true;
    }
    offset=end+(size%2);
  }
  if(!found)throw Error('Expected animated WebP');
  return data;
}
