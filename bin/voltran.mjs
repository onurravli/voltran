#!/usr/bin/env node
import { runCli } from '../packages/daemon/src/cli.ts';

runCli(process.argv.slice(2)).catch((error) => {
    console.error(`voltran: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
});
