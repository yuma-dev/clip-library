'use strict';

/** Maps items through async fn with at most limit calls in flight, order kept.
 * Avoids an unbounded Promise.all queuing thousands of fs calls on the libuv threadpool at once. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = { mapLimit };
