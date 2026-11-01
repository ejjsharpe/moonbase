// Controlled TCP child only: this is not SSH or host-key qualification.
import { appendFileSync, existsSync, unlinkSync } from 'node:fs';
import net from 'node:net';
const args = process.argv.slice(2),
  log = process.env.MOONBASE_CHAT_FORWARD_LOG;
if (args.includes('-G')) {
  appendFileSync(log, JSON.stringify({ event: 'preflight', pid: process.pid }) + '\n');
  process.stdout.write('stricthostkeychecking yes\n');
} else {
  const value = args[args.indexOf('-L') + 1].split(':'),
    port = Number(value[1]),
    remotePort = Number(value[3]);
  const sockets = new Set();
  const server = net.createServer((socket) => {
    const remote = net.connect({ host: '127.0.0.1', port: remotePort });
    let pending = Buffer.alloc(0),
      drop = false;
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 128 * 1024) {
        pending = Buffer.alloc(0);
        return;
      }
      for (;;) {
        const end = pending.indexOf('\r\n\r\n');
        if (end < 0) return;
        const header = pending.subarray(0, end).toString(),
          length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? 0);
        if (pending.length < end + 4 + length) return;
        const body = pending.subarray(end + 4, end + 4 + length);
        pending = pending.subarray(end + 4 + length);
        if (
          header.startsWith('POST /v1/chat ') &&
          existsSync(process.env.MOONBASE_CHAT_DROP_SEND)
        ) {
          try {
            if (JSON.parse(body.toString()).operation === 'sendChat') {
              unlinkSync(process.env.MOONBASE_CHAT_DROP_SEND);
              drop = true;
            }
          } catch {}
        }
      }
    });
    remote.on('data', () => {
      if (drop) {
        appendFileSync(
          log,
          JSON.stringify({ event: 'drop-send-response', pid: process.pid }) + '\n',
        );
        socket.destroy();
        remote.destroy();
      }
    });
    for (const connection of [socket, remote]) {
      sockets.add(connection);
      connection.on('close', () => sockets.delete(connection));
    }
    socket.on('error', () => remote.destroy());
    remote.on('error', () => socket.destroy());
    socket.pipe(remote).pipe(socket);
  });
  server.on('error', () => process.exit(255));
  server.listen(port, '127.0.0.1', () =>
    appendFileSync(log, JSON.stringify({ event: 'forward', pid: process.pid, port }) + '\n'),
  );
  process.on('SIGTERM', () => {
    for (const socket of sockets) socket.destroy();
    server.close(() => process.exit(0));
  });
}
