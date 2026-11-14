// Controlled TCP child only: this is not SSH or host-key qualification.
import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
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
      drop = false,
      tamper = false;
    // The client's bytes: the upgrade request, then masked WebSocket frames, each a 32-byte MAC
    // and JSON. A request for the directive's operation drops or tampers with what follows it.
    let upgraded = false;
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 1024 * 1024) {
        pending = Buffer.alloc(0);
        return;
      }
      if (!upgraded) {
        const end = pending.indexOf('\r\n\r\n');
        if (end < 0) return;
        upgraded = true;
        pending = pending.subarray(end + 4);
      }
      for (;;) {
        if (pending.length < 2) return;
        let length = pending[1] & 0x7f,
          offset = 2;
        if (length === 126) {
          if (pending.length < 4) return;
          length = pending.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (pending.length < 10) return;
          length = Number(pending.readBigUInt64BE(2));
          offset = 10;
        }
        const masked = (pending[1] & 0x80) !== 0,
          start = offset + (masked ? 4 : 0);
        if (pending.length < start + length) return;
        const payload = Buffer.from(pending.subarray(start, start + length));
        if (masked)
          for (let i = 0; i < payload.length; i++) payload[i] ^= pending[offset + (i % 4)];
        pending = pending.subarray(start + length);
        if (!existsSync(process.env.MOONBASE_CHAT_DROP_SEND) || payload.length <= 32) continue;
        try {
          const directive = readFileSync(process.env.MOONBASE_CHAT_DROP_SEND, 'utf8') || 'sendChat';
          const operation = directive.replace(/^tamper:/, '');
          const message = JSON.parse(payload.subarray(32).toString());
          if (message.type === 'request' && message.operation === operation) {
            unlinkSync(process.env.MOONBASE_CHAT_DROP_SEND);
            if (directive.startsWith('tamper:')) tamper = true;
            else drop = true;
          }
        } catch {}
      }
    });
    remote.on('data', (chunk) => {
      if (tamper && chunk.length) {
        chunk[chunk.length - 1] ^= 1;
        tamper = false;
      }
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
