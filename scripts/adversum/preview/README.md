# Browser preview (dev tool)

Runs the real React frontend in a normal browser, without the native app. A
small script (`fakeTauri.ts`) stands in for the Tauri backend and for a Kimai
server with sample customers, projects, activities and 90 days of history
(`fakeKimai.ts`). Nothing here is part of a build, and no real Kimai instance
or credential is involved.

```sh
./scripts/adversum/env.sh npm run dev
```

Then open one of:

- http://localhost:1420/scripts/adversum/preview/index.html (tray popup)
- `…/index.html?window=settings` (settings window)
- `…/index.html?window=timer-reminder`
- `…/index.html?window=adversum-quick` (quick entry bar)

Useful query parameters: `theme=dark`, `layout=classic|focus|taskbar|timeline`,
`indicator=logo|dots`, `reset=1` (forget the stored sample state).

State (settings, favorites, timesheets) lives in `localStorage`, so several
tabs behave like several app windows and events are passed between them.
Unknown native commands are logged to the console as `[fake tauri] unhandled`.

Limits: native menus, global shortcuts, window positioning and the real logo
download do not exist here. Logos are generated sample images.
