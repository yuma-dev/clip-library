'use strict';

/**
 * Map `items` through an async `fn` with at most `limit` calls in flight.
 * Results keep the input order. Used where an unbounded Promise.all over a
 * whole library (thousands of stats or reads) would queue everything on the
 * libuv threadpool at once and starve every other file operation.
 */
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
