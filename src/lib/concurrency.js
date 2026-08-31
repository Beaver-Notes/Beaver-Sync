'use strict';

// Runs `fn` over `items` with bounded concurrency, preserving order.
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push((async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) break;
        results[index] = await fn(items[index], index);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

module.exports = { mapWithConcurrency };
