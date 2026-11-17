#!/usr/bin/env node
import { run } from '../lib/installer.mjs';

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`herdr-mattpocock-skills: ${error.message}\n`);
  process.exitCode = 1;
}
