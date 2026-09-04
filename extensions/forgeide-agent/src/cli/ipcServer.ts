import * as net from 'net';
import * as readline from 'readline';
import { AgentDaemon } from '../daemon/agentDaemon';
import { IpcClient } from '../daemon/ipcClient';

/**
 * IpcServer — exposes the agent daemon over a simple line-protocol so the
 * CLI companion can talk to a running extension session.
 *
 * The CLI connects to the same Unix socket / named pipe as the extension,
 * sends JSON commands, and streams back responses to stdout.
 *
 * This module is the server side (used inside the extension).
 * The CLI entry point (forgeide-cli.ts) is the client side.
 */
export class IpcServer {
    static getSocketPath(): string {
        return AgentDaemon.defaultSocketPath();
    }
}

/**
 * CLI client — reads commands from stdin, sends to daemon, prints responses.
 * Invoked by the forgeide-cli entry point.
 */
export async function runCliClient(args: string[]): Promise<void> {
    const client = new IpcClient();

    try {
        await client.connect();
    } catch (e: any) {
        console.error(`forgeide-cli: cannot connect to daemon at ${AgentDaemon.defaultSocketPath()}`);
        console.error('  Is ForgeIDE running in VS Code? Start it with F5 or open a workspace.');
        process.exit(1);
    }

    const command = args[0];

    if (!command || command === '--help' || command === '-h') {
        printHelp();
        process.exit(0);
    }

    if (command === 'ping') {
        const ok = await client.ping();
        console.log(ok ? '✓ daemon is running' : '✗ daemon did not respond');
        process.exit(ok ? 0 : 1);
    }

    if (command === 'spec') {
        const prompt = args.slice(1).join(' ');
        if (!prompt) { console.error('Usage: forgeide spec <prompt>'); process.exit(1); }
        console.log(`Creating spec for: "${prompt}"`);
        const result = await client.send('spec.create', { prompt });
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
    }

    if (command === 'status') {
        const result = await client.send('ping');
        console.log(`Daemon: ${result}`);
        process.exit(0);
    }

    if (command === 'index') {
        console.log('Rebuilding codebase index...');
        const result = await client.send<{ summary: string }>('index.rebuild');
        console.log(`Index: ${result?.summary ?? 'done'}`);
        process.exit(0);
    }

    if (command === 'task') {
        const specId  = args[1];
        const taskId  = args[2];
        if (!specId || !taskId) {
            console.error('Usage: forgeide task <specId> <taskId>');
            process.exit(1);
        }
        console.log(`Implementing task ${taskId} from spec ${specId}...`);
        const result = await client.send('task.run', { specId, taskId });
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
    }

    if (command === 'chat') {
        // Interactive chat mode — reads lines from stdin
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        console.log('ForgeIDE Chat (type "exit" to quit)\n');
        rl.on('line', async (line) => {
            if (line.trim() === 'exit') { rl.close(); process.exit(0); }
            process.stdout.write('\nAgent: ');
            await client.streamChat(
                [{ role: 'user', content: line }],
                (token) => process.stdout.write(token)
            );
            process.stdout.write('\n\n> ');
        });
        process.stdout.write('> ');
        return; // keep alive
    }

    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}

function printHelp(): void {
    console.log(`
forgeide-cli — ForgeIDE terminal companion

Usage:
  forgeide ping              Check if the daemon is running
  forgeide status            Print daemon status
  forgeide spec <prompt>     Create a spec from a prompt
  forgeide task <id> <tid>   Implement a task (specId, taskId)
  forgeide index             Rebuild the codebase index
  forgeide chat              Interactive chat mode (reads from stdin)

The CLI connects to the ForgeIDE agent daemon running inside VS Code.
Start VS Code with ForgeIDE loaded first.
`);
}
