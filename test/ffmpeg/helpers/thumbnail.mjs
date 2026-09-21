import assert from 'node:assert/strict';
import { thumbnails } from './fixture.mjs';

export async function generateLibraryThumbnail(f) {
  let message;
  const event = { sender: { send(channel, payload) {
    if (channel === 'thumbnail-generated' || channel === 'thumbnail-generation-failed') {
      message = { channel, payload };
    }
  } } };
  // main.js delegates directly here; loading the app would start unrelated services.
  await thumbnails.generateThumbnailsProgressively([f.name], event, f.settings, async () => null);
  assert.ok(message, 'thumbnail generation must report a result');
  assert.equal(message.channel, 'thumbnail-generated', message.payload.error);
  assert.equal(message.payload.clipName, f.name);
  return message.payload.thumbnailPath;
}
