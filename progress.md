Original prompt: Добавь ссылку на git https://massivedev0.github.io/pac-fpom/ на главной странице, перед x, чтобы больше доверия было.
Окно connect wallet оптимизируй и под мобильные, сейчас на Iphone SE выходит за края.
Когда сначала portrait, потом перехожу на landscape на живом Iphone SE, игра не по экоану, приходится перезагружать страницу.

- Reviewed title-screen links, wallet modal layout, and mobile runtime resize/orientation handling.
- Planned fixes: add Git link in shared project links/menu, make wallet modal content wrap and scroll safely on narrow screens, and recompute game shell size from visual viewport after orientation changes.
- Added a dedicated `Git` footer link before `X` on the title screen.
- Updated the wallet modal markup/styles for narrow mobile screens: safer padding, scrollable card, stacked action buttons, and shorter account labels.
- Switched mobile viewport sizing to prefer `visualViewport` and added repeated post-orientation layout passes plus visual viewport listeners for iPhone rotation.
- Verified `npm run build` succeeds.
- Ran the web-game Playwright client against `http://127.0.0.1:4181` and produced fresh smoke artifacts in `tests/playwright/artifacts/postfix-smoke/`.
- Captured iPhone SE screenshots for portrait and portrait-to-landscape rotation in `tests/playwright/artifacts/mobile-check/`; landscape metrics show the shell and wallet modal remain inside the 667x375 viewport after rotation.
- Follow-up tweaks: added a leading `WEB` footer button, centered the account-picker action buttons, and moved the mobile title-screen content slightly higher with extra bottom reserve for the footer links.
- New request: shrink and move the mobile pause button to the right-center safe area, and improve iPhone sound playback by unlocking/resuming WebAudio more reliably on touch/click gestures.
- Implemented a smaller mobile pause button anchored to the right-center edge.
- Added iPhone-friendlier WebAudio unlock flow: awaited resume on Start, plus capture-phase touch/pointer unlock hooks and a tiny warmup tick for Safari.
- Re-ran `npm run build`, Playwright smoke, and captured a fresh mobile gameplay screenshot in `tests/playwright/artifacts/mobile-pause-audio-2/`; sound behavior could not be acoustically verified from automation.
- Follow-up audio fix: removed the async/await-based unlock path that could lose the trusted gesture on mobile, and switched to direct synchronous `resume()` calls from gesture handlers/start button/keydown.
- Verified again with `npm run build` and a fresh Playwright smoke run in `tests/playwright/artifacts/postfix-smoke-audio-3/`.
