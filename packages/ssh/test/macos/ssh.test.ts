import { test } from 'node:test';
import { checkSystemPolicy } from '../ssh-fixture.ts';

// macOS's OpenSSH reports NoHostAuthenticationForProxyCommand from `ssh -G`; Ubuntu's 9.6 refuses it.
for (const enabled of [true, false])
  test(`actual system policy NoHostAuthenticationForProxyCommand ${enabled ? 'rejects enabled bypass' : 'preserves normal verification'}`, () =>
    checkSystemPolicy(
      'NoHostAuthenticationForProxyCommand',
      'ProxyCommand /usr/bin/false',
      enabled,
    ));
