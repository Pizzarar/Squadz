// Squadz first-run default: dark theme, ignoring the OS light preference.
// Only runs when the user has never saved Cinny settings; their own choice always wins afterwards.
try {
  if (!localStorage.getItem("settings")) {
    localStorage.setItem("settings", JSON.stringify({ useSystemTheme: false, themeId: "dark-theme" }));
  }
} catch (_) { /* storage blocked: Cinny falls back to its own defaults */ }
