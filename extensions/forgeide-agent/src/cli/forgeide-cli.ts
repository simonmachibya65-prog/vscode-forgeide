#!/usr/bin/env node
/**
 * forgeide-cli — entry point for the ForgeIDE terminal companion.
 *
 * Compiled to out/cli/forgeide-cli.js and exposed via package.json "bin".
 * Users run: npx forgeide-cli <command> [args]
 *
 * Connects to the agent daemon running inside VS Code and sends commands
 * via the local IPC socket (same protocol as the extension uses).
 */
import { runCliClient } from './ipcServer';

const args = process.argv.slice(2);
runCliClient(args).catch((e) => {
    console.error('forgeide-cli error:', e.message ?? e);
    process.exit(1);
});
