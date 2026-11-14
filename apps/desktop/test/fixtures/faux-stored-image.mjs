// Controlled remote host behaviour for `tests/chat/daemon-host.ts`: a faux model whose tool
// returns retained images, from `stored-image-fixture.ts`; temporary SQLite only.
import { installFaux } from '../../../../tests/chat/faux-model.ts';
import { createImageProviders } from './stored-image-fixture.ts';

export function createBehaviour() {
  const { faux, registry } = createImageProviders();
  return {
    installProviders: (models) => installFaux(models, faux),
    registry,
    stats: () => ({ calls: faux.state.callCount, tools: 0 }),
    release: () => {},
  };
}
