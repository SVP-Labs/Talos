#!/usr/bin/env node
import { processIo } from '../cli/io.js';
import { main } from '../cli/main.js';
import { launch } from '../version/launch.js';

const argv = process.argv.slice(2);
process.exitCode = (await launch(argv)) ?? (await main(argv, processIo));
