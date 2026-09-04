# X Profile Country Flag (Firefox extension)

When you open someone's profile on x.com / twitter.com, this automatically
opens the "Joined ..." panel that X already puts on every profile, reads
the **"Account based in [Country]"** line if X shows one, closes the panel
again, and drops a flag next to the person's name — one click saved, every
time. The first time you visit a given profile you'll see a brief, normal-
looking flicker (the same navigate-and-back you'd see doing this by hand);
after that it's cached and shows instantly with no visible transition.

**Status:** personal project, not affiliated with or endorsed by X Corp.
It relies on X's current markup and an undocumented internal feature
("Account based in"), so it can break without notice if X changes either.
No claim is made about whether or how X's abuse-detection systems treat
this extension's behavior — those systems are undisclosed and outside
anyone's ability to verify from the outside, so none of this documentation
should be read as a guarantee about that.

## How it works (and what it does *not* do)

- It never calls X's API directly, never touches your auth token/cookies,
  and never hardcodes any of X's private GraphQL query IDs.
- It finds the "Joined" control X already renders on a profile and
  simulates a real click on it — the same button press you'd make
  yourself. Whatever request results is the exact request X's own client
  makes for that action; the extension only automates your click, not the
  network call.
- As of the current X markup, "Joined ..." is a real link to
  `/<handle>/about`, not an inline popup — clicking it can either layer
  content on top of the profile or swap the page to that route, and X's
  own router has been observed pushing more than one history entry for
  it (the "have to press Back twice" behavior). The script doesn't
  assume either shape: it waits for the phrase "Account based in" to
  show up anywhere on the page, reads it, then presses Back
  (programmatically) as many times as it takes to land back on the
  profile URL — so you land back where you started without needing to
  press anything yourself, though you will see the transition happen
  (a brief flicker, once per new profile — see the note in `content.js`
  about why this isn't hidden).
- Results are cached locally (`browser.storage.local`) for 14 days per
  handle, so revisiting a profile you've already seen costs nothing and
  never re-triggers the click.
- Coverage depends entirely on what X has populated: many accounts don't
  have this field yet, and X itself warns the value can be wrong when a
  VPN/proxy is detected. This extension just surfaces whatever X is
  already willing to show.
- Sometimes X gives a broad region instead of a country ("North America",
  "Europe") when its confidence is lower. There's no flag for a
  continent, so those get a globe emoji (🌎/🌍/🌏) instead — hover it to
  see the exact text X showed.
- X's own React code can re-render the profile header after the
  auto-click-and-return round trip and wipe out the badge this extension
  injected, since React doesn't know about it. A `MutationObserver` plus
  a short polling check after every resolution both watch for exactly
  that and re-insert the badge if it disappears, logging every time they
  do.
- Clicking from one profile to another inside X (rather than a full page
  load) can leave the *previous* profile's header mounted for a moment
  while the new one loads. Without checking, the script could grab the
  outgoing profile's "Joined" link a split second before it's replaced —
  silently resolving and caching the wrong person's country. It now
  verifies the link it's about to click actually points at the profile
  whose URL you're currently on before clicking it.
- Detecting that you'd navigated to a new profile at all turned out to be
  the biggest issue: patching `history.pushState`/`replaceState` (the
  usual way to notice SPA navigation) never fired on X, because X's own
  app code grabs a reference to the real `pushState` before a content
  script gets a chance to patch it — so the patched version just sits
  there unused. This is now solved by polling `location.pathname`
  directly every 300ms, which works no matter how X implements routing
  internally.
- A real report caught a nastier bug downstream of that fix: for one
  account, the "Account based in" text apparently didn't match the
  parsing regex (probably an unusual format — a VPN-detected caveat, a
  leading flag emoji, something along those lines), so nothing ever got
  cached for that handle. Every time the auto-navigate-and-return round
  trip landed back on the profile, the polling watcher saw that as "a new
  navigation," found no cache, and clicked Joined again — an infinite
  click/navigate loop with no way to leave the page short of closing the
  tab. Two independent fixes now guard against this: every outcome, not
  just successes, gets cached (failures for a shorter 1-hour window, in
  case it was transient), and a hard 20-second cooldown per handle makes
  it physically impossible to re-enter the click flow in a tight loop
  regardless of the reason. If this happens again, the console will now
  log the actual text surrounding "Account based in" that failed to
  parse — worth sending along so the regex in `resolveCountryByAutoClick`
  can be widened to cover it.

## Install (temporary, for trying it out)

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `manifest.json` inside this folder.
4. Visit any profile on x.com — a flag should appear next to the name
   shortly after the page loads (or immediately, for a cached handle).

Temporary add-ons are removed when Firefox closes, so you'll reload it
each session. For a permanent install, Firefox requires Mozilla's
signature on the `.xpi` even for private, unlisted use — submit it at
[addons.mozilla.org/developers](https://addons.mozilla.org/developers/)
choosing "On your own" (unlisted) distribution, which signs it without
publishing it publicly. The only way around signing entirely is running
Firefox Developer Edition or Nightly with
`xpinstall.signatures.required` disabled in `about:config`.

## Files

- `manifest.json` — extension manifest (MV3, Firefox).
- `content.js` — all the logic described above.
- `countries.js` — auto-generated country-name → flag-emoji lookup table
  (~460 names/aliases, sourced from ISO 3166 via `pycountry`).
- `popup.html` / `popup.js` — toolbar popup: on/off toggle and a
  "clear cached flags" button.
- `icons/` — placeholder icons (swap these for your own anytime).

## If flags stop appearing after an X update

X changes its markup periodically. Open a profile, inspect the "Joined"
line and the panel it opens, and check the `SELECTORS` block at the top
of `content.js` — that's the one place selectors live. The script also
falls back to plain-text matching ("Joined ...") if the expected
`data-testid` isn't found, so small X changes often don't require any
edit at all.

## If a country name doesn't get a flag

Open `countries.js` and add the exact text X displays as a new key in
`COUNTRY_NAME_TO_ISO2`, mapped to its two-letter ISO code, e.g.:

```js
"Republic of Whatever": "XX"
```

## License

MIT — see [LICENSE](LICENSE).
