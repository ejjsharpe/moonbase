import type { ConnectionErrorReason } from '@moonbase/contracts/connection-errors';

/**
 * The options every owned OpenSSH child runs with: in the foreground, without a shell, a
 * multiplexing master, agent or X11 forwarding, or any command, and failing if its forward can't
 * bind. Host-key checking and known hosts are left to the user's OpenSSH configuration, which
 * `refusedPolicy` checks rather than overrides.
 */
export const sshOptions = [
  '-N',
  '-T',
  '-n',
  '-o',
  'BatchMode=yes',
  '-o',
  'ExitOnForwardFailure=yes',
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
  '-o',
  'ControlPersist=no',
  '-o',
  'ForkAfterAuthentication=no',
  '-o',
  'GatewayPorts=no',
  '-o',
  'PermitLocalCommand=no',
  '-o',
  'RemoteCommand=none',
  '-o',
  'ForwardAgent=no',
  '-o',
  'ForwardX11=no',
] as const;

/**
 * Why the effective configuration `ssh -G` printed for a destination is refused, if it is: extra
 * forwards, host-key checking turned off, a host-authentication bypass, or cleared forwards and
 * device tunnels. Policy is rejected, never rewritten.
 */
export function refusedPolicy(configuration: string): ConnectionErrorReason | undefined {
  if (/^(localforward|remoteforward|dynamicforward)\s+/im.test(configuration))
    return 'policy-forwards';
  if (/^stricthostkeychecking\s+(false|no|off)\s*$/im.test(configuration)) return 'policy-host-key';
  if (
    /^nohostauthenticationfor(?:localhost|proxycommand)\s+(?!no\s*$|false\s*$|off\s*$)\S+/im.test(
      configuration,
    )
  )
    return 'policy-host-authentication';
  if (
    /^clearallforwardings\s+yes\s*$/im.test(configuration) ||
    /^tunnel\s+(?!false\s*$|no\s*$|none\s*$)\S+/im.test(configuration)
  )
    return 'policy-tunnel';
  return undefined;
}
