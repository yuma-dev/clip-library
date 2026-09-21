import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ffmpegPath as ffmpeg } from '../../main/ffmpeg-binaries.js';
import { ffprobePath } from '../../main/ffmpeg-binaries.js';

export async function chooseMedia(spec, options, out) {
  if (options.clip && options.color) throw Error('choose --clip or --color, not both');
  if (options.color) {
    if (!/^#[0-9a-f]{6}$/i.test(options.color)) throw Error('color must be #RRGGBB');
    const thumbnail = path.join(out, 'solid.svg');
    await fs.writeFile(thumbnail, `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><path fill="${options.color}" d="M0 0h1920v1080H0z"/></svg>`);
    spec.media = { kind: 'color', color: options.color, thumbnail:thumbnail.replaceAll('\\','/') };
    return;
  }
  if (!options.clip) return;
  const clip = path.resolve(options.clip);
  await fs.access(clip);
  const metadata = JSON.parse(execFileSync(ffprobePath, ['-v','error','-show_streams','-show_format','-of','json',clip], { encoding:'utf8', windowsHide:true }));
  const duration = Number(metadata.format.duration);
  const offset = Number(options.offset ?? 0);
  if (!Number.isFinite(offset) || offset < 0 || offset >= duration) throw Error('offset outside clip');
  const thumbnail = path.join(out, options.thumbnail ? `thumbnail${path.extname(options.thumbnail).toLowerCase()}` : 'thumbnail.png');
  if (options.thumbnail) await fs.copyFile(path.resolve(options.thumbnail), thumbnail);
  else execFileSync(ffmpeg, ['-v','error','-ss',String(offset),'-i',clip,'-frames:v','1',thumbnail], { windowsHide:true });
  spec.media = { kind:'clip', path:clip.replaceAll('\\','/'), thumbnail:thumbnail.replaceAll('\\','/'), duration, offset };
  spec.props ??= {};
  spec.props.durationSeconds = duration;
  const palette = ['#3b82f6','#f43f5e','#10b981','#a855f7','#f59e0b','#06b6d4','#ec4899','#84cc16'];
  spec.props.tracks = metadata.streams.filter(s => s.codec_type === 'audio').map((s, ordinal) => ({ ordinal, name:s.tags?.title || (!/^sound\s*handler$/i.test(s.tags?.handler_name ?? '') ? s.tags?.handler_name : '') || `Track ${ordinal + 1}`, channels:s.channels, color:palette[ordinal % palette.length], volume:1 }));
  if (spec.fixtures[0]) spec.fixtures[0].clip = { ...spec.fixtures[0].clip, originalName:path.basename(clip), customName:path.basename(clip,path.extname(clip)), thumbnailPath:spec.media.thumbnail };
  await fs.writeFile(path.join(out,'media-info.json'), JSON.stringify({ path:clip, duration, streams:metadata.streams.map(s => ({ index:s.index, codec:s.codec_name, type:s.codec_type, width:s.width, height:s.height, channels:s.channels, tags:s.tags })) }, null, 2));
}
