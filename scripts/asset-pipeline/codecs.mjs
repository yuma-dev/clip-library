export function flatten(background) {
  const color = /^#[a-fA-F0-9]{6}$/.test(background ?? '') ? background : '#000000';
  return `split[fg][bg];[bg]drawbox=c=${color}:t=fill:replace=1[base];[base][fg]overlay=format=auto,format=rgb24`;
}

export function encodingArguments(format, background) {
  if(format==='mov')return ['-c:v','prores_ks','-profile:v','4','-pix_fmt','yuva444p10le'];
  if(format==='webm')return ['-c:v','libvpx-vp9','-pix_fmt','yuva420p','-auto-alt-ref','0','-lossless','1','-deadline','good','-cpu-used','4','-row-mt','1'];
  if(format==='mp4')return ['-vf',`${flatten(background)},pad=ceil(iw/2)*2:ceil(ih/2)*2`,'-c:v','libx264','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart'];
  throw Error(`Unknown animation codec: ${format}`);
}
