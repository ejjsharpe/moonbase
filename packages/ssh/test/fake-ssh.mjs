// Independently authored controlled child: real TCP forwarding, never SSH/host-key proof.
import { appendFileSync, readFileSync } from 'node:fs';
import net from 'node:net';
import {execFileSync, spawn} from 'node:child_process';
const control = JSON.parse(readFileSync(process.env.MOONBASE_SSH_TEST_CONTROL, 'utf8'));
const args = process.argv.slice(2), preflight = args.includes('-G');
const record = event => appendFileSync(control.log, JSON.stringify({pid: process.pid, event, args, keyInEnvironment: Object.values(process.env).some(value => value.includes(control.key))}) + '\n');
record(preflight ? 'preflight' : 'forward');
if (preflight) {
  if (control.sshConfig) { process.stdout.write(execFileSync('/usr/bin/ssh', ['-F', control.sshConfig, ...args])); }
  else process.stdout.write(control.mode === 'extra-forward' ? 'localforward 0.0.0.0:4444 localhost:4444\n' : control.mode === 'key-policy' ? 'stricthostkeychecking false\n' : 'stricthostkeychecking ask\n');
  if (control.mode === 'clear-forward') process.stdout.write('clearallforwardings yes\n');
  if (control.mode === 'device-tunnel') process.stdout.write('tunnel point-to-point\n');
  if (control.mode === 'overflow') process.stdout.write('x'.repeat(100000));
  process.exitCode = 0;
} else {
  const forward = args[args.indexOf('-L') + 1].split(':'), port = Number(forward[1]), remotePort = Number(forward[3]);
  if (['held-stderr', 'held-both', 'held-none'].includes(control.mode)) {
    const helperCode = `const fs=require('node:fs'), net=require('node:net');
      const server=net.createServer(); server.listen(0,'127.0.0.1',()=>fs.appendFileSync(${JSON.stringify(control.log)},JSON.stringify({event:'helper',pid:process.pid,parent:process.ppid,port:server.address().port})+'\\n'));
      ${control.mode !== 'held-stderr' ? `process.on('SIGTERM',()=>fs.appendFileSync(${JSON.stringify(control.log)},JSON.stringify({event:'helper-term',pid:process.pid})+'\\n'));` : ''}`;
    spawn(process.execPath, ['-e', helperCode], {stdio: ['ignore', control.mode === 'held-both' ? 1 : 'ignore', control.mode === 'held-none' ? 'ignore' : 2]});
  }
  const sockets = new Set(), server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    const remote = net.connect({host: '127.0.0.1', port: remotePort}); sockets.add(remote);
    remote.on('error', () => socket.destroy()); remote.on('close', () => sockets.delete(remote));
    socket.pipe(remote).pipe(socket);
  });
  let blocker, start;
  const finish = () => { clearTimeout(start); for (const socket of sockets) socket.destroy(); server.close(() => { blocker?.close(); process.exit(0); }); };
  process.on('SIGTERM', () => { record('term'); if (control.mode !== 'ignore-term') finish(); });
  server.on('error', e => { process.stderr.write(e.code + ': address already in use ' + control.key); process.exit(255); });
  if (control.mode === 'early') { process.stderr.write((control.diagnostic ?? 'early failure') + ' ' + control.key); process.exit(255); }
  else if (control.mode === 'collision') { blocker = net.createServer(); blocker.listen(port, '127.0.0.1', () => server.listen(port, '127.0.0.1')); }
  else if (control.mode === 'wait') { setInterval(() => {}, 1000); }
  else start = setTimeout(() => {
    server.listen(port, '127.0.0.1', () => record('listening'));
    process.stderr.write(control.key.repeat(10000));
  }, control.mode === 'slow' ? 1000 : 0);
}
