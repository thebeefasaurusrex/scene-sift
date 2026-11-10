#!/usr/bin/env node
import { map } from '../lib/map.mjs';

const args = process.argv.slice(2);
if (args[0] === '--help' || args[0] === '-h') {
  console.log("Usage: scene-sift [outline | build | find <symbol> | show <file> <function>] [--cwd <path>] [--full]");
} else {
  try {
    process.exitCode = await map(args);
  } catch (error) {
    console.error('ERROR ' + String(error.message).replace(/\s+/g, ' ').slice(0, 500));
    process.exitCode = 2;
  }
}
