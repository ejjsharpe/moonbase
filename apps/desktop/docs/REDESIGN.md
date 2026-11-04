# Desktop redesign

Mode: Operate. The user wants a close adaptation of the supplied Cursor desktop screenshot. This pinned direction settles the visual world; code-first mockups show actual app composition.

## Scope

Desktop owns Agents/project navigation and chat presentation. Application owns preserved new-chat drafts and create-and-send. Workbench owns compact file actions and the paste destination. UI owns shared neutral tokens, control recipes and the named Tabler outlined icon selection. Controllers, adapters and exact resource identities stay at their existing boundaries.

## Direction contract

THESIS: Start by talking. One pinned Agents destination precedes project tabs; no project or saved-chat creation is needed to type.

OWN-WORLD: `#141415` canvas, `#161618` sidebars and coordinated cool-neutral controls, subdued borders, Manrope interface text, SpaceMono Nerd Font Mono code and consistent 16px Tabler outlined icons. The browser-tab references govern the main tab shape: rounded inset active surfaces, left-aligned labels, vertical centering and equal outer padding, with 4px above and below. Every adjacent tab uses the same 6px gap, including Agents. Short dividers separate inactive neighbors. Inactive text is dim; hover brightens text and background. Close controls appear on selection, hover or keyboard focus, retaining their layout space. Agents remains distinct and pinned before projects. File-tree rows use aligned file/folder icons and an open-folder state for expanded directories.

STORY: Type a message, choose an approved folder and configured model when needed, and send. The first send creates the saved conversation. Open a project with the tab-strip plus to edit its files.

MODEL PREFERENCE: First-time local chats show the maintained provider default. Model and reasoning effort changes persist across chats and restarts, independently of the selected conversation. Existing settings and retained command inputs stay exact. Missing catalog choices stay preserved and visibly require replacement.

FIRST VIEWPORT: A 40px macOS-compatible tab strip with inset native window buttons and no separate title caption, a 288px sidebar with New chat and saved conversations, and a centered 640px composer. Redundant sidebar branding and the visible empty-chat heading are omitted to match the reference. New-chat composition sits around the vertical middle; saved chats use a transcript with the composer below. Provider setup and identity details are secondary disclosures. File tools fit on compact icon rows.

FORM: User-pinned reference adaptation; seed:09148c466bb8e386. The user-pinned reference overrides the roll. Taste style: True-black flat, seed 1090732663; use the reference’s charcoal levels, sidebar and user-selected Manrope and Space Mono fonts in place of the dealt pure black, no-sidebar shell and pill controls. Signature interaction: the first send turns the new-chat composer into a saved conversation without losing newer edits or uncertain command evidence.

MOTION: Motion (`motion/react`) provides 200ms entry/reflow and 140ms exits without bounce, animating transforms/opacity rather than layout widths. Tabs and plus slide to their new positions; disappearing tabs become inert immediately. Initial tabs do not animate on load. Reduced motion keeps 80ms fades and immediate reflow. Preservation and cleanup notices sit below the strip so its vertical position cannot change during Close.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
