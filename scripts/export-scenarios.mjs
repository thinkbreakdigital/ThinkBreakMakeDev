if (process.argv.length > 2) {
  throw new Error('export-scenarios.mjs does not accept arguments. Use npm run make:pull.');
}

process.argv.push('--pull-only');
await import('./sync-scenarios.mjs');
