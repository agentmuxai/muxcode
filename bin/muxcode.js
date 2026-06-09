#!/usr/bin/env node
import { buildCli } from '../dist/cli.js';

buildCli().parseAsync(process.argv).catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
