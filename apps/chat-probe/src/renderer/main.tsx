import { createRoot } from 'react-dom/client';
import * as stylex from '@stylexjs/stylex';
import { workbench } from '@moonbase/ui/workbench';
import '@moonbase/ui/reset.css';
import { ChatProof, createChatProof } from '../ui.tsx';
import { browserClients, type ChatBridge } from '../wire.ts';
declare global {
  interface Window {
    moonbaseChat: ChatBridge;
  }
}
Object.assign(document.documentElement, stylex.props(workbench.document));
const bridge = window.moonbaseChat;
try {
  const context = await bridge.context(),
    clients = browserClients(bridge),
    controller = createChatProof({ ...clients, context, storage: localStorage });
  bridge.quit((id) => bridge.consent(id, controller.preserve()));
  window.addEventListener('beforeunload', (event) => {
    if (!controller.preserve()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  window.addEventListener('unload', () => controller.dispose());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) controller.detach();
    else void controller.start();
  });
  createRoot(document.getElementById('root')!).render(<ChatProof controller={controller} />);
  bridge.ready();
} catch {
  document.getElementById('root')!.textContent =
    'Chat proof could not initialize. Preserve its user-data directory and check the privileged configuration.';
}
