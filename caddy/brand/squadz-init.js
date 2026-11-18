// Squadz first-run default: dark theme, ignoring the OS light preference.
// Only runs when the user has never saved Cinny settings; their own choice always wins afterwards.
try {
  if (!localStorage.getItem("settings")) {
    localStorage.setItem("settings", JSON.stringify({ useSystemTheme: false, themeId: "dark-theme" }));
  }
} catch (_) { /* storage blocked: Cinny falls back to its own defaults */ }

// Squadz Go-Live entry (Block G1): a small link shown while Cinny's call view is visible.
// Cinny 4.12.8 keeps a permanent <div data-call-embed-container> and flips its inline
// visibility between "hidden" and visible when a call/voice room is on screen. The room comes
// from the route (/home|/direct/<room>[/<event>] or /<space>/<room>). Everything is best-effort:
// any DOM or route surprise just hides the link, it never throws into Cinny.
(function squadzGoLive() {
  var ID = "squadz-golive";
  function roomFromPath() {
    try {
      var parts = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      for (var i = parts.length - 1; i >= 0; i--) {
        if (parts[i][0] === "!" || parts[i][0] === "#") return parts[i];
      }
    } catch (_) { /* malformed URI */ }
    return null;
  }
  function inCall() {
    var c = document.querySelector("[data-call-embed-container]");
    return !!c && c.style.visibility !== "hidden";
  }
  function sync() {
    try {
      var room = inCall() ? roomFromPath() : null;
      var el = document.getElementById(ID);
      if (!room) { if (el) el.remove(); return; }
      if (!el) {
        el = document.createElement("a");
        el.id = ID;
        el.target = "_blank";
        el.rel = "noopener";
        el.setAttribute("aria-label", "Go Live: stream your screen at high quality (opens in a new tab)");
        el.title = "Stream your screen at high FPS";
        el.textContent = "\u25CF Go Live";
        (document.body || document.documentElement).appendChild(el);
      }
      var href = "/golive?room=" + encodeURIComponent(room);
      if (el.getAttribute("href") !== href) el.setAttribute("href", href);
    } catch (_) { /* Cinny DOM changed: stay silent */ }
  }
  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    (window.requestAnimationFrame || setTimeout)(function () { queued = false; sync(); });
  }
  try {
    var start = function () {
      new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
      window.addEventListener("popstate", schedule);
      sync();
    };
    if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
  } catch (_) { /* no MutationObserver: no button */ }
})();
