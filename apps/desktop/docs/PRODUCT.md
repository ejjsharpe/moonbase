# Moonbase desktop

<!-- impeccable:product-schema 1 -->

## Platform

web

Electron supplies the native macOS window, menus, approved file pickers and clipboard capabilities.

## Users and purpose

Moonbase is a personal workbench for talking to agents and editing local projects. The user starts in Agents, even without an open project. Opening a project reveals its editor. A new conversation starts with the first message, without a separate chat-creation form.

## Operating context

Projects are exact approved local checkouts. Local conversations require an approved working folder and configured model; optional remote conversations use a separately configured host. Editor buffers and chat drafts survive navigation. Agents can keep working while their view is hidden.

First-time local composition uses a maintained model/effort default per provider. An explicit user choice takes precedence across new conversations, panel reopening and app restarts. Existing conversations retain their captured settings. Unavailable preferences require an explicit replacement rather than a silent fallback.

## Capabilities and constraints

Reuse the existing headless controllers, StyleX recipes and Base UI interactions. Preserve explicit sending, provider authentication, local tool notices, retained command identities, exact checkout authority and Save/Discard/Cancel decisions. File imports enter the existing destination/replacement flow. Pasting files belongs in the editor's file sidebar; text paste in the editor remains ordinary editing.

## Brand commitments

The supplied Cursor screenshots are the visual reference: a close adaptation with main canvas `#141415`, sidebars `#161618`, a narrow sidebar, Tabler outlined icons and a spacious chat composer. The additional browser-tab screenshots establish rounded inset main tabs, short dividers between inactive neighbors, dim inactive text that brightens with hover background, and close controls shown for selection or hover. Keyboard focus also reveals close controls. Tab labels are left-aligned and vertically centered, with equal outer padding. Agents is visually distinct and pinned at the left of project navigation, using the same 6px gap as every other adjacent tab. Open project is a plus beside the tabs. Native window buttons share the custom tab strip; no separate macOS title bar or app-name caption is shown. Editor file actions and tree rows use Tabler outlined icons; file/folder names align, and expanded folders use an open-folder icon.

Tab addition, removal and reflow use Motion for spatial continuity. Close gates and command timing remain authoritative; an exiting visual tab cannot receive input. The tab strip stays fixed while preservation/cleanup notices appear below it. Reduced motion replaces sliding with short fades and immediate layout changes.

## Evidence on hand

The repository has runnable controlled browser and Electron fixtures. Provider and SSH behavior must not be exercised against real services without explicit authorization. Mockups use illustrative conversations and project names, never claims about real agent activity.
