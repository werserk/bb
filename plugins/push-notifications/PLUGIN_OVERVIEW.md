Get a notification when an agent asks a question, finishes a turn, or stops on an error. Plugins and the CLI can send their own too. Choose mobile, web, and desktop delivery independently in Settings → Push notifications.

## Delivery

Mobile devices receive push messages through Expo, including when the app is closed. Web browsers and the desktop app receive system notifications over bb's live connection while a tab or window stays open; web delivery needs HTTPS (or localhost) and notification permission. Mobile WebViews use mobile push only.

Each thread has a level: `all` (questions, approvals, errors, finished turns), `input-only` (no finished turns), or `muted`. A thread uses its own level, else the nearest ancestor child level, else global `childLevel` if it has a parent, else `defaultLevel`; every ancestor's own level caps it. Muting a parent mutes its whole subtree, but a parent never makes workers louder. The level applies on top of the suppressions below.

Click a notification to open its thread, or bb when it has none; in the desktop app the click also restores and focuses the window. With the `skipFocusedThreadNotifications` experiment (on for early adopters), a thread open in a visible, focused window or tab is not notified. Events arriving together are combined, with pending questions taking priority. Read, archived, deleted, and hidden threads are suppressed. Tabs of the same origin deduplicate delivery.

## Thread menu

Every thread menu (header, sidebar row, right-click, compact drawer, optional row quick action) has a **Notifications** entry for unarchived threads: Default, All activity, Needs input only, Muted. The entry shows the current level; Default names its fallback; a footnote says when a parent limits it. Thread plugin metadata stores a thread's own level, `{ "notifications": { "own" } }`; limits are read from the current parent chain. Menus fetch levels for threads on screen in batches.

## Settings

- `mobileEnabled` / **Mobile notifications**: send to registered phones and tablets. Default: true.
- `webEnabled` / **Web notifications**: notify connected browsers with permission. Default: true.
- `desktopEnabled` / **Desktop notifications**: notify running desktop clients. Default: true.
- `defaultLevel` / **Default notifications**: `all`, `input-only`, or `muted`, for threads you haven't set. Default: `all`.
- `childLevel` / **Child thread notifications**: `inherit` (same as `defaultLevel`), `all`, `input-only`, or `muted`. Default: `input-only`.
- `expoPushUrl` / **Expo push relay URL**: mobile relay endpoint. Defaults to `https://exp.host/--/api/v2/push/send`.

Channel switches apply to this server and save immediately. Browser permission is granted per device with **Allow notifications**. **Send test notification** confirms broadcast, not OS display.

## CLI and SDK

`bb push-notifications` manages mobile devices, shows status, sends and tests notifications, and reads or sets a thread's level; `bb plugin config push-notifications` changes the settings above. The bundled `push-notifications` skill documents every command and RPC method. Plugins and agents send notifications with the discoverable `notifications.send` RPC; `bb plugin rpc inspect push-notifications notifications.send` prints its schemas. Permission requests still require a click in the target client.

Root threads expose **Notifications for new threads**. It stores a separate
`childNotifications: { level }` metadata key; `inherit` removes that key.
Descendants start from their own level, then the nearest ancestor child level,
then the global child default, then the global default. Ancestor own-level caps
still only lower the result. A thread's child level never affects itself.
`bb push-notifications thread <id> --child-level <inherit|all|input-only|questions-only|muted>`
uses the same writer as the menu and `threadNotifications.setChildLevel` RPC.
