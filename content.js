// X Profile Country Flag — content script
//
// What this does, in order, every time you land on a profile page:
//   1. Notice the URL is a profile (not home/explore/a tweet/etc).
//   2. Check local cache — if we already resolved this handle recently, just
//      paint the flag from cache and stop. No network activity at all.
//   3. Otherwise, find the "Joined ..." control X already renders on every
//      profile and *simulate a real click on it* — the same thing a human
//      does to open X's "account info" view. We never call X's API
//      ourselves and never touch auth tokens; we just automate the same
//      button press, so whatever request happens is the exact request X's
//      own client would normally make.
//   4. Read "Account based in <Country>" out of whatever X renders, get
//      back to the profile the same way pressing Back would (X has been
//      observed sometimes needing more than one Back to fully return —
//      see returnToProfile() below — so this is handled automatically,
//      you should never need to press anything), cache the result, and
//      drop a flag next to the display name.
//
// This whole round trip is genuinely visible — you'll see a brief, normal-
// looking navigate-away-and-back on a profile you haven't visited before,
// the same as if you'd tapped "Joined" and then Back yourself. That's
// expected and not worth hiding: an earlier version tried blanking the
// whole page during the round trip so you wouldn't see it, but that read as
// a much more jarring "flash" than the plain transition it was hiding, so
// it was removed. Since results are cached for two weeks, this only
// happens once per profile — repeat visits paint instantly from cache with
// no visible transition at all.
//
// Coverage is inherently limited by X: many accounts don't have this field
// populated yet (feature rollout is still uneven), and X itself warns the
// value can be wrong when a VPN/proxy is detected. This script just surfaces
// whatever X is already willing to show you.
//
// NOTE ON SELECTORS AND BEHAVIOR: as of this version, "Joined <date>" on a
// profile is a real link to /<handle>/about — not an inline popup — so
// clicking it may swap the visible content or layer something on top,
// depending on how X is rendering it for you at the moment. This script
// doesn't assume either shape: it just waits for the phrase "Account based
// in" to show up anywhere on the page, reads it, and then gets back to the
// profile URL. If X changes this again, the SELECTORS block and
// findJoinedTrigger()/returnToProfile() below are the places to adjust —
// open a profile, inspect the "Joined" line, click it, and see what
// actually happens to the URL and DOM.

(() => {
  const SELECTORS = {
    // Candidates for the "Joined <date>" control on a profile header.
    // We don't rely on any single one — see findJoinedTrigger() below.
    joinedTestIds: ["UserJoinDate"],
    // Candidate containers for the big display name at the top of a profile.
    nameTestIds: ["UserName", "UserProfileHeader_Items"],
    dialogRole: '[role="dialog"]',
    closeButtonAria: '[aria-label="Close"]',
  };

  const CACHE_PREFIX = "xflag:";
  const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days, for a confirmed result
  const FAILURE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour, for "tried and got nothing usable"
  const FLAG_MARKER_ATTR = "data-x-country-flag";
  const INFO_APPEAR_TIMEOUT_MS = 6000; // time to wait for "Account based in" text
  const RETURN_STEP_TIMEOUT_MS = 1200; // time to wait after each Back attempt
  const MAX_RETURN_ATTEMPTS = 3; // X has been seen needing 2 Backs; 3 is a safety margin
  // Hard circuit breaker: no matter what else might go wrong, never let the
  // same handle re-enter the auto-click flow more than once in this window.
  // This exists specifically to make an infinite click/navigate loop
  // physically impossible, even from a failure mode nobody's found yet.
  const ATTEMPT_COOLDOWN_MS = 20000;
  const RESERVED_PATH_SEGMENTS = new Set([
    "home", "explore", "notifications", "messages", "i", "compose", "search",
    "settings", "hashtag", "login", "logout", "tos", "privacy", "about",
    "download", "jobs", "share", "intent", "topics", "communities", "lists",
    "bookmarks", "moments", "premium_sign_up", "premium", "verified-orgs",
    "verified-orgs-signup", "grok", "flow",
  ]);

  let extensionEnabled = true;
  let currentRunToken = 0; // lets a newer profile navigation cancel an older in-flight run
  const attemptCooldowns = new Map(); // handle (lowercased) -> timestamp of last attempt start

  const log = (...args) => console.log("[XFlag]", ...args);

  log("content script loaded on", location.href);
  init();

  async function init() {
    extensionEnabled = await getEnabledSetting();
    log("enabled setting:", extensionEnabled);
    browser.storage.onChanged.addListener((changes) => {
      if (changes.xflagEnabled) {
        extensionEnabled = !!changes.xflagEnabled.newValue;
        log("enabled setting changed to:", extensionEnabled);
      }
    });

    watchForNavigation(() => handleNavigation());
    startSelfHealingObserver();
    handleNavigation(); // handle the very first load too
  }

  function getEnabledSetting() {
    return browser.storage.local
      .get("xflagEnabled")
      .then((r) => r.xflagEnabled !== false) // default ON
      .catch(() => true);
  }

  // ---- SPA navigation detection -------------------------------------------
  // X never does a full page load when you click between profiles, so
  // something has to notice the URL changing without one. The "proper" way
  // is patching history.pushState/replaceState — but in testing that never
  // fired on X at all: X's own app code grabs a reference to the *real*
  // pushState before a content script gets a chance to run (content scripts
  // inject after the page's own bundle is already executing), so replacing
  // window.history.pushState afterward patches a reference nothing actually
  // calls. Watching the <title> element for changes was tried as a backup
  // and didn't reliably fire either.
  //
  // So this just polls location.pathname directly. It's a blunter tool, but
  // it cannot be bypassed no matter how X implements its routing internally
  // — it doesn't care whether X used pushState, the Navigation API, or
  // something else entirely. 300ms is frequent enough to feel instant and
  // cheap enough to run for the life of the tab (it's one string compare).
  function watchForNavigation(onChange) {
    let lastPath = location.pathname;
    const checkForChange = () => {
      if (location.pathname !== lastPath) {
        log("navigation detected:", lastPath, "->", location.pathname);
        lastPath = location.pathname;
        onChange();
      }
    };
    setInterval(checkForChange, 300);
    window.addEventListener("popstate", checkForChange); // instant for real back/forward
  }

  function getProfileHandleFromPath(pathname = location.pathname) {
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return null; // profile URLs are exactly /<handle>
    const handle = parts[0];
    if (RESERVED_PATH_SEGMENTS.has(handle.toLowerCase())) return null;
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
    return handle;
  }

  // Only an actual profile URL bumps the run token / clears the flag. A
  // transient hop to /<handle>/about (our own auto-click, or X routing that
  // way) does NOT — that would otherwise invalidate our own in-flight run
  // and wipe the flag out from under it. See resolveCountryByAutoClick().
  async function handleNavigation() {
    const handle = getProfileHandleFromPath();
    if (!handle) {
      log("not a profile page, skipping:", location.pathname);
      return;
    }

    const myToken = ++currentRunToken;
    removeExistingFlag();

    if (!extensionEnabled) {
      log("skipping @" + handle + " — extension disabled in popup");
      return;
    }
    log("profile detected:", "@" + handle);

    const cached = await getCached(handle);
    if (cached) {
      if (cached.failed) {
        log("cache says @" + handle + " was already tried and yielded nothing usable — not retrying yet");
      } else {
        log("cache hit for @" + handle + ":", cached.country, cached.flag);
        await waitForNameElement(myToken);
        if (myToken === currentRunToken && cached.flag) {
          paintFlag(cached.flag, cached.country, handle, { verbose: true });
          reassertBadgeForAWhile(handle);
        }
      }
      return;
    }
    log("no cache for @" + handle + ", looking for the Joined control…");

    // Hard stop, independent of caching: never let the same handle re-enter
    // the click-and-navigate flow more than once per ATTEMPT_COOLDOWN_MS.
    // This is what makes an infinite click/navigate loop physically
    // impossible even if some future edge case slips past the cache logic
    // below — a real report showed exactly that: a handle whose "Account
    // based in" text didn't parse cleanly never got cached either way, so
    // every bounce back to its profile re-triggered the click, forever.
    const lastAttemptKey = handle.toLowerCase();
    const lastAttempt = attemptCooldowns.get(lastAttemptKey);
    if (lastAttempt && Date.now() - lastAttempt < ATTEMPT_COOLDOWN_MS) {
      log(
        "skipping @" + handle + " — attempted",
        Math.round((Date.now() - lastAttempt) / 1000),
        "s ago, cooling down to avoid a repeat-click loop"
      );
      return;
    }
    attemptCooldowns.set(lastAttemptKey, Date.now());

    const country = await resolveCountryByAutoClick(myToken, handle);
    if (myToken !== currentRunToken) {
      log("a newer navigation took over for @" + handle + " — leaving painting to that run");
      return;
    }
    if (!country) {
      log("no 'Account based in' data found for @" + handle);
      return;
    }

    const flag = resolveFlagEmoji(country);
    log("resolved @" + handle + " ->", country, flag || "(no matching flag emoji)");
    if (flag) {
      paintFlag(flag, country, handle, { verbose: true });
      reassertBadgeForAWhile(handle);
    }
  }

  // ---- Cache ---------------------------------------------------------------
  async function getCached(handle) {
    try {
      const key = CACHE_PREFIX + handle.toLowerCase();
      const stored = await browser.storage.local.get(key);
      const entry = stored[key];
      if (!entry) return null;
      const ttl = entry.failed ? FAILURE_CACHE_TTL_MS : CACHE_TTL_MS;
      if (Date.now() - entry.ts > ttl) return null;
      return entry;
    } catch {
      return null;
    }
  }

  async function setCached(handle, { country, flag, failed = false }) {
    try {
      const key = CACHE_PREFIX + handle.toLowerCase();
      await browser.storage.local.set({ [key]: { country, flag, failed, ts: Date.now() } });
    } catch {
      /* storage full or unavailable — non-fatal, just skip caching */
    }
  }

  // ---- The auto-click-and-read flow -----------------------------------------
  // We cache the result *before* navigating back, on purpose: going back
  // fires our own navigation watcher again for the profile URL, which will
  // immediately re-run handleNavigation(). Caching first means that re-run
  // finds a cache hit and just paints (or, on failure, just stops) — it
  // doesn't loop back into clicking Joined again.
  //
  // Every exit path below caches *something*, success or failure. Early on,
  // only successes were cached — a real-world report showed the fallout:
  // one account's "Account based in" text apparently didn't match the
  // parsing regex, country came back null, nothing got cached, and the
  // return-navigation's own re-trigger found no cache and clicked Joined
  // again — forever, with the page bouncing back and forth and no way to
  // navigate away short of closing the tab. Caching failures too (for a
  // shorter hour-long window, in case it was transient) closes that hole;
  // the ATTEMPT_COOLDOWN_MS check in handleNavigation is a second,
  // independent backstop in case some other path still slips through.
  async function resolveCountryByAutoClick(myToken, handle) {
    const originalPath = location.pathname;

    const trigger = await waitFor(() => findJoinedTrigger(handle), 7000);
    if (!trigger) {
      log(
        "could not find a 'Joined' control for @" + handle + " within 7s — either the previous",
        "profile's DOM never cleared, X's markup changed, or this took unusually long to load"
      );
      await setCached(handle, { country: null, flag: null, failed: true });
      return null;
    }
    if (myToken !== currentRunToken) return null;
    log("found Joined control for @" + handle + ", auto-clicking it…", trigger.outerHTML?.slice(0, 160));

    try {
      trigger.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
      );

      const appeared = await waitFor(
        () => /account based in/i.test(document.body.innerText || ""),
        INFO_APPEAR_TIMEOUT_MS
      );

      if (!appeared) {
        log(
          "clicked Joined but never saw an 'Account based in' line within",
          INFO_APPEAR_TIMEOUT_MS,
          "ms — X may not have this data for this account, or the page changed"
        );
        await setCached(handle, { country: null, flag: null, failed: true });
        return null;
      }

      const text = document.body.innerText || "";
      const match = text.match(/Account based in\s*:?\s*([A-Za-z][A-Za-z .'()-]*)/i);
      const country = match ? match[1].trim().replace(/[.,]$/, "") : null;

      if (country) {
        const flag = resolveFlagEmoji(country);
        await setCached(handle, { country, flag });
        log("cached @" + handle + " ->", country, flag);
      } else {
        log(
          "found 'Account based in' but couldn't parse a clean country from the text that followed",
          "— caching this as a (temporary) failure instead of retrying forever. Surrounding text:",
          text.match(/.{0,80}account based in.{0,80}/i)?.[0]
        );
        await setCached(handle, { country: null, flag: null, failed: true });
      }

      return country;
    } catch (err) {
      log("error while reading account info:", err);
      await setCached(handle, { country: null, flag: null, failed: true });
      return null;
    } finally {
      // Get back to the profile URL — whether that means closing an overlay
      // or undoing a real route change.
      if (location.pathname !== originalPath) {
        await returnToProfile(originalPath);
      } else {
        closeDialogIfAny();
      }
    }
  }

  // X has been observed pushing more than one history entry for its account
  // info view, which is exactly the "press Back twice" behavior you'd see
  // doing this by hand. We just press Back (programmatically) until we're
  // actually looking at the profile URL again, up to a small safety cap.
  async function returnToProfile(originalPath, maxAttempts = MAX_RETURN_ATTEMPTS) {
    for (let i = 0; i < maxAttempts && location.pathname !== originalPath; i++) {
      log(`navigating back toward ${originalPath} (attempt ${i + 1})`);
      history.back();
      await waitFor(() => location.pathname === originalPath, RETURN_STEP_TIMEOUT_MS);
    }
    if (location.pathname !== originalPath) {
      log(
        "couldn't automatically return to",
        originalPath,
        "— if the page looks stuck, press Back once yourself"
      );
    }
  }

  function closeDialogIfAny() {
    const dialog = document.querySelector(SELECTORS.dialogRole);
    if (!dialog) return;
    const closeBtn = dialog.querySelector(SELECTORS.closeButtonAria);
    if (closeBtn) {
      closeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return;
    }
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })
    );
  }

  // X can leave the *previous* profile's header mounted for a moment while
  // the new one's data is still loading (a "keep old content while fetching"
  // pattern). If we don't check whose "Joined" link we actually found, a
  // fast in-app click from one profile to another can grab the outgoing
  // profile's link a split second before it's replaced — silently reading
  // and caching the wrong person's country. `handle` lets us reject a match
  // that doesn't actually belong to the profile we're trying to resolve, and
  // keep polling until the real one mounts (or we time out).
  function findJoinedTrigger(handle) {
    const belongsToHandle = (clickable) => {
      const link = clickable?.closest ? clickable.closest("a") : null;
      if (!link) return true; // nothing to check against — allow it through
      const href = (link.getAttribute("href") || "").split(/[?#]/)[0];
      return href === `/${handle}` || href.startsWith(`/${handle}/`);
    };

    for (const testId of SELECTORS.joinedTestIds) {
      const el = document.querySelector(`[data-testid="${testId}"]`);
      if (el) {
        const clickable = closestClickable(el);
        if (belongsToHandle(clickable)) return clickable;
      }
    }
    // Fallback: hunt for an element whose own text starts with "Joined".
    // This is what actually matches X's current markup, where "Joined" is
    // the visible text of a plain link rather than something carrying one
    // of the testIds above.
    const candidates = document.querySelectorAll("span, div");
    for (const el of candidates) {
      const text = el.textContent?.trim();
      if (text && /^Joined\s/.test(text) && el.children.length === 0) {
        const clickable = closestClickable(el);
        if (belongsToHandle(clickable)) return clickable;
      }
    }
    return null;
  }

  function closestClickable(el) {
    return (
      el.closest("a") ||
      el.closest('[role="button"]') ||
      el.closest("[tabindex]") ||
      el
    );
  }

  // ---- Painting the flag -----------------------------------------------------
  // X's own React code re-renders the profile header after our auto-click-
  // and-return round trip (and sometimes at other random moments — new data
  // arriving, a re-fetch, etc). React owns that DOM and doesn't know about
  // our badge, so a re-render can silently wipe it out even though we
  // resolved everything correctly. `activeBadge` plus the MutationObserver
  // in startSelfHealingObserver() below exist specifically to notice that
  // and put the badge straight back, instead of making you refresh to see it.
  let activeBadge = null; // { handle, flag, country } for whatever's currently shown

  async function waitForNameElement(myToken) {
    return waitFor(() => myToken === currentRunToken && findNameContainer(), 5000);
  }

  // Logs *every* candidate match, not just the one we pick, so a report of
  // "it didn't show up" can be diagnosed from the console output alone —
  // e.g. if X's markup uses the same data-testid for a tweet author's byline
  // as for the profile header itself, this will show more than one match
  // and tell us which one got picked.
  function findNameContainer({ verbose = false } = {}) {
    for (const testId of SELECTORS.nameTestIds) {
      const matches = document.querySelectorAll(`[data-testid="${testId}"]`);
      if (verbose && matches.length) {
        log(
          `"${testId}" matched ${matches.length} element(s); using the first:`,
          matches[0].outerHTML.slice(0, 160)
        );
      }
      if (matches.length) return matches[0];
    }
    const heading = document.querySelector("h1, h2");
    if (verbose) {
      log(
        "no data-testid match for",
        SELECTORS.nameTestIds,
        "— falling back to first h1/h2:",
        heading ? heading.outerHTML.slice(0, 160) : "(none found either)"
      );
    }
    return heading;
  }

  function paintFlag(flag, country, handle, { verbose = false } = {}) {
    if (!flag) return false;
    const container = findNameContainer({ verbose });
    if (!container) {
      if (verbose) log("paintFlag: no name container found at all for @" + handle);
      return false;
    }

    activeBadge = { handle, flag, country };
    if (container.querySelector(`[${FLAG_MARKER_ATTR}]`)) return true; // already showing

    const badge = document.createElement("span");
    badge.setAttribute(FLAG_MARKER_ATTR, "1");
    badge.textContent = " " + flag;
    badge.title = `X: Account based in ${country}`;
    badge.style.marginLeft = "4px";
    badge.style.fontSize = "1.05em";
    container.appendChild(badge);
    if (verbose) log("paintFlag: inserted badge for @" + handle, "into", container.outerHTML.slice(0, 160));
    return true;
  }

  // Watches for X re-rendering our badge away and restores it. Debounced so
  // a burst of unrelated page mutations (new tweets loading, etc.) only
  // costs one cheap check, not one per mutation.
  function startSelfHealingObserver() {
    let recheckScheduled = false;
    const observer = new MutationObserver(() => {
      if (recheckScheduled) return;
      recheckScheduled = true;
      setTimeout(() => {
        recheckScheduled = false;
        recheckBadge();
      }, 200);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function recheckBadge(verbose = false) {
    if (!activeBadge) return;
    const currentHandle = getProfileHandleFromPath();
    if (!currentHandle || currentHandle.toLowerCase() !== activeBadge.handle.toLowerCase()) {
      return; // moved to a different (or non-profile) page; not our job anymore
    }
    if (document.querySelector(`[${FLAG_MARKER_ATTR}]`)) {
      if (verbose) log("badge check for @" + activeBadge.handle + ": still present");
      return;
    }
    log("flag for @" + activeBadge.handle + " is missing from the page — restoring it");
    paintFlag(activeBadge.flag, activeBadge.country, activeBadge.handle, { verbose: true });
  }

  // Belt-and-suspenders: in addition to the MutationObserver above, also
  // just poll for a while after every resolution. This catches anything the
  // observer might miss (e.g. a mutation batch it coalesced oddly) and, with
  // verbose logging, gives us a clear before/after trail in the console if
  // the badge is still getting lost somewhere.
  function reassertBadgeForAWhile(handle, { checks = 10, intervalMs = 500 } = {}) {
    let i = 0;
    const tick = () => {
      if (i === 0) log("watching @" + handle + "'s badge for the next", (checks * intervalMs) / 1000, "s to make sure it sticks…");
      i++;
      if (!activeBadge || activeBadge.handle.toLowerCase() !== handle.toLowerCase()) return; // superseded
      recheckBadge(true);
      if (i < checks) setTimeout(tick, intervalMs);
      else log("done watching @" + handle + "'s badge — present:", !!document.querySelector(`[${FLAG_MARKER_ATTR}]`));
    };
    tick();
  }

  function removeExistingFlag() {
    activeBadge = null;
    document.querySelectorAll(`[${FLAG_MARKER_ATTR}]`).forEach((el) => el.remove());
  }

  // ---- Small utility: poll until a condition is true or time runs out -------
  function waitFor(check, timeoutMs, intervalMs = 100) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        let result;
        try {
          result = check();
        } catch {
          result = null;
        }
        if (result) return resolve(result);
        if (Date.now() - start >= timeoutMs) return resolve(null);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }
})();
