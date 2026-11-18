// scripts/lib/server.mjs
//
// Discord-style "server settings" for the Squadz Space (`squadz server show|set`)
// and the welcome message (config/welcome.md) that is posted + pinned in #general.
// Everything is idempotent: unchanged state is never re-PUT, and re-running
// `--welcome` with identical text does not post again. No dependencies.
//
// Note: #general is end-to-end encrypted, so the welcome m.notice is sent in
// plaintext (the CLI has no Olm). Servers accept this and clients display it
// with an "unencrypted message" shield; it is public house info, not a secret.

import crypto from "node:crypto";
import { ROOMS, SPACE } from "./seed.mjs";
import { sniffImage } from "./emoji.mjs";

export const WELCOME_STATE_TYPE = "dev.squadz.welcome"; // state_key "": { event_id, sha256 }
export const ICON_STATE_TYPE = "dev.squadz.icon"; // state_key "": { url, sha256 } (upload cache)
export const MAX_ICON_BYTES = 2 * 1024 * 1024;
const ICON_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const SLUGS = [SPACE.slug, ...ROOMS.map((r) => r.slug)];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?![*\w])/g, "$1<em>$2</em>");
}

/** Minimal, safe markdown -> html: headings, bullet lists, bold, italic, code, paragraphs. */
export function markdownToHtml(md) {
  const out = [];
  let list = false;
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push("</ul>");
    list = false;
  };
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) {
      flush();
      closeList();
    } else if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flush();
      closeList();
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flush();
      if (!list) out.push("<ul>");
      list = true;
      out.push(`<li>${inline(m[1])}</li>`);
    } else {
      closeList();
      para.push(line.trim());
    }
  }
  flush();
  closeList();
  return out.join("");
}

export function welcomeContent(md) {
  const text = md.replace(/\r\n?/g, "\n").trim();
  return {
    msgtype: "m.notice",
    body: text,
    format: "org.matrix.custom.html",
    formatted_body: markdownToHtml(text),
  };
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function parseTopicArg(arg) {
  const i = String(arg).indexOf("=");
  if (i < 1) throw new Error(`--topic expects <room>=<text>, got "${arg}"`);
  const slug = arg.slice(0, i).trim().replace(/^#/, "").split(":")[0].toLowerCase();
  if (!SLUGS.includes(slug)) throw new Error(`unknown room "${slug}" for --topic (known: ${SLUGS.join(", ")})`);
  return { slug, text: arg.slice(i + 1).trim() };
}

async function roomIds(client, config) {
  const ids = {};
  for (const slug of SLUGS) {
    const id = await client.resolveAlias(`#${slug}:${config.serverName}`);
    if (id) ids[slug] = id;
  }
  if (!ids[SPACE.slug]) throw new Error("the Squadz Space was not found. Run: node scripts/bootstrap.mjs");
  return ids;
}

async function putIfChanged(client, roomId, type, content) {
  const cur = await client.getState(roomId, type, "");
  if (JSON.stringify(cur) === JSON.stringify(content)) return false;
  await client.putState(roomId, type, "", content);
  return true;
}

/**
 * Post `md` as an m.notice in #general and pin it, replacing any previous
 * Squadz welcome pin (other pins are kept). No-op if the text is unchanged
 * and still pinned. With `onlyIfMissing`, does nothing when a welcome exists.
 */
export async function postWelcome(client, config, md, { onlyIfMissing = false, ids } = {}) {
  ids ??= await roomIds(client, config);
  const general = ids.general;
  if (!general) throw new Error("#general was not found. Run: node scripts/bootstrap.mjs");
  const rec = await client.getState(general, WELCOME_STATE_TYPE, "");
  if (rec?.event_id && onlyIfMissing) return { posted: false, eventId: rec.event_id, reason: "exists" };
  const content = welcomeContent(md);
  const hash = sha(content.body);
  const pins = (await client.getState(general, "m.room.pinned_events", ""))?.pinned ?? [];
  if (rec?.sha256 === hash && pins.includes(rec.event_id)) {
    return { posted: false, eventId: rec.event_id, reason: "unchanged" };
  }
  const { event_id } = await client.sendMessage(general, content);
  const next = [...pins.filter((p) => p !== rec?.event_id), event_id];
  await client.putState(general, "m.room.pinned_events", "", { pinned: next });
  await client.putState(general, WELCOME_STATE_TYPE, "", { event_id, sha256: hash });
  return { posted: true, eventId: event_id, replaced: rec?.event_id ?? null };
}

/**
 * Apply server settings.
 * @param opts { name, icon: {bytes, filename}, iconAll, topics: [{slug,text}], welcome: string }
 * @returns {{ changed: string[], unchanged: string[], welcome?: object }}
 */
export async function setServer(client, config, opts) {
  const changed = [];
  const unchanged = [];
  const note = (label, did) => (did ? changed : unchanged).push(label);
  const ids = await roomIds(client, config);
  const space = ids[SPACE.slug];

  if (opts.name !== undefined) {
    const name = String(opts.name).trim();
    if (!name) throw new Error("--name must not be empty");
    note("name", await putIfChanged(client, space, "m.room.name", { name }));
  }

  if (opts.icon) {
    const { bytes } = opts.icon;
    const meta = sniffImage(bytes);
    if (!meta || !ICON_TYPES.has(meta.mimetype)) throw new Error("--icon must be a png, jpg or webp image");
    if (!meta.w || !meta.h) throw new Error("icon has zero width/height");
    if (bytes.length > MAX_ICON_BYTES) throw new Error(`icon is ${(bytes.length / 1024).toFixed(0)}KB; the limit is ${MAX_ICON_BYTES / 1024}KB`);
    // Reuse the previously uploaded mxc when the bytes are identical (idempotent).
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const rec = await client.getState(space, ICON_STATE_TYPE, "");
    let url = rec?.sha256 === hash ? rec.url : null;
    if (!url) {
      url = (await client.upload(opts.icon.filename || "icon", bytes, meta.mimetype)).content_uri;
      await client.putState(space, ICON_STATE_TYPE, "", { url, sha256: hash });
    }
    const info = { w: meta.w, h: meta.h, size: bytes.length, mimetype: meta.mimetype };
    const targets = opts.iconAll ? SLUGS.filter((s) => ids[s]) : [SPACE.slug];
    for (const slug of targets) {
      const label = slug === SPACE.slug ? "icon" : `icon:${slug}`;
      note(label, await putIfChanged(client, ids[slug], "m.room.avatar", { url, info }));
    }
  }

  for (const { slug, text } of opts.topics ?? []) {
    if (!ids[slug]) throw new Error(`room #${slug} not found on the server`);
    note(`topic:${slug}`, await putIfChanged(client, ids[slug], "m.room.topic", { topic: text }));
  }

  let welcome;
  if (opts.welcome !== undefined) {
    welcome = await postWelcome(client, config, opts.welcome, { ids });
    note("welcome", welcome.posted);
  }
  return { changed, unchanged, welcome };
}

/** Current settings: name, avatar, topics, pinned welcome event id. */
export async function showServer(client, config) {
  const ids = await roomIds(client, config);
  const topics = {};
  for (const slug of SLUGS) {
    if (!ids[slug]) continue;
    topics[slug] = (await client.getState(ids[slug], "m.room.topic", ""))?.topic ?? null;
  }
  const rec = ids.general ? await client.getState(ids.general, WELCOME_STATE_TYPE, "") : null;
  const pins = ids.general ? (await client.getState(ids.general, "m.room.pinned_events", ""))?.pinned ?? [] : [];
  return {
    name: (await client.getState(ids[SPACE.slug], "m.room.name", ""))?.name ?? null,
    avatar: (await client.getState(ids[SPACE.slug], "m.room.avatar", ""))?.url ?? null,
    topics,
    welcomeEventId: rec?.event_id && pins.includes(rec.event_id) ? rec.event_id : null,
  };
}
