// node on Windows resolves an explicit test directory through its index file.
(async () => {
  for (const file of ['resolver.test.cjs', 'binaries.test.mjs', 'fetch.test.mjs', 'bridge.test.mjs',
    'probe.test.mjs', 'export.test.mjs', 'audio-analysis.test.mjs', 'perf.test.mjs']) {
    await import(`./${file}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
