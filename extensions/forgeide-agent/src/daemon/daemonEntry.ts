/**
 * daemonEntry.ts — compiled to out/daemon/daemonEntry.js and spawned as a
 * separate Node.js process by DaemonProcess. Runs the AgentDaemon IPC server
 * standalone so it survives extension host reloads.
 *
 * Communication: the parent extension connects via the local socket and sends
 * newline-delimited JSON (see agentDaemon.ts protocol).
 */
import { AgentDaemon } from './agentDaemon';

const socketPath = process.env['FORGEIDE_SOCKET'] ?? AgentDaemon.defaultSocketPath();
const workspace  = process.env['FORGEIDE_WORKSPACE'] ?? process.cwd();

const daemon = new AgentDaemon(socketPath);

// Built-in ping handler (others are registered from the extension via IPC)
daemon.on('ping', async (_p, send) => send({ data: 'pong' }));

daemon.start()
    .then(() => {
        console.log(`[forgeide-daemon] listening on ${socketPath} (workspace: ${workspace})`);
    })
    .catch((e) => {
        console.error('[forgeide-daemon] failed to start:', e.message);
        process.exit(1);
    });

// Graceful shutdown on SIGTERM / SIGINT
process.on('SIGTERM', () => daemon.stop().then(() => process.exit(0)));
process.on('SIGINT',  () => daemon.stop().then(() => process.exit(0)));
