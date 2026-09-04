const toggle = document.getElementById("enabledToggle");
const clearBtn = document.getElementById("clearCache");
const status = document.getElementById("status");

browser.storage.local.get("xflagEnabled").then((r) => {
  toggle.checked = r.xflagEnabled !== false; // default ON
});

toggle.addEventListener("change", () => {
  browser.storage.local.set({ xflagEnabled: toggle.checked });
  status.textContent = toggle.checked ? "Enabled." : "Disabled.";
});

clearBtn.addEventListener("click", async () => {
  const all = await browser.storage.local.get(null);
  const keysToRemove = Object.keys(all).filter((k) => k.startsWith("xflag:"));
  await browser.storage.local.remove(keysToRemove);
  status.textContent = `Cleared ${keysToRemove.length} cached flag${keysToRemove.length === 1 ? "" : "s"}.`;
});
