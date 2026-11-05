import { createRoot } from 'react-dom/client';
import { Menu } from '@base-ui/react/menu';

const last = [...document.querySelectorAll('button')].find(
  (button) => button.textContent === 'Dispose second editor',
)!;
const element = document.createElement('span');
last.after(element);
createRoot(element).render(
  <Menu.Root>
    <Menu.Trigger>Consumer overlay</Menu.Trigger>
    <Menu.Portal>
      <Menu.Positioner>
        <Menu.Popup aria-label="Consumer navigation">
          <Menu.Item>Last consumer action</Menu.Item>
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>,
);
