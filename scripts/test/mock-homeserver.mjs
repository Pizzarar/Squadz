// scripts/test/mock-homeserver.mjs
//
// A minimal in-process Matrix Client-Server homeserver (node:http) with just
// enough behaviour for bootstrap.mjs to run against it in tests. It tracks
// every mutation so tests can assert idempotency (a second run creates nothing).

import http from "node:http";
import { EventEmitter } from "node:events";

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length });
  res.end(data);
}

function error(res, status, errcode, message) {
  json(res, status, { errcode, error: message });
}

/**
 * @param {object} opts
 * @param {string} opts.serverName e.g. "chat.squadz.test"
 * @param {string} opts.registrationToken the valid registration token
 */
export function createMockHomeserver({ serverName, registrationToken }) {
  const state = {
    serverName,
    registrationToken,
    users: new Map(), // localpart -> { password }
    tokens: new Map(), // access token -> localpart
    aliases: new Map(), // "#slug:server" -> roomId
    rooms: new Map(), // roomId -> { roomId, alias, state: Map<type \0 key, content>, members: Map<userId, membership> }
    mediaCount: 0,
    // Mutation counters used by the idempotency test.
    counts: { register: 0, login: 0, createRoom: 0, upload: 0, invite: 0, putState: 0 },
    // Auth stage sequence observed during registration (for the UIA test).
    registerStages: [], // { username, type }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    const readBody = () =>
      new Promise((resolve) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const buf = Buffer.concat(chunks);
          if (!buf.length) return resolve(null);
          const text = buf.toString("utf8");
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(buf); // raw bytes (media upload)
          }
        });
      });

    const actor = () => {
      const auth = req.headers.authorization || "";
      const m = auth.match(/^Bearer (.+)$/);
      if (m) {
        const localpart = state.tokens.get(m[1]);
        if (localpart) return localpart;
      }
      return null;
    };

    (async () => {
      const body = await readBody();

      // --- auth ----------------------------------------------------------
      if (req.method === "POST" && pathname === "/_matrix/client/v3/login") {
        state.counts.login++;
        const localpart = body?.identifier?.user ?? body?.user;
        const user = state.users.get(localpart);
        if (!user || user.password !== body?.password) {
          return error(res, 403, "M_FORBIDDEN", "Invalid username or password");
        }
        const token = `tok-${localpart}-${state.tokens.size + 1}`;
        state.tokens.set(token, localpart);
        return json(res, 200, {
          user_id: `@${localpart}:${serverName}`,
          access_token: token,
          device_id: "BOOTSTRAP",
        });
      }

      if (req.method === "POST" && pathname === "/_matrix/client/v3/register") {
        state.counts.register++;
        const localpart = body?.username;
        if (state.users.has(localpart)) {
          return error(res, 400, "M_USER_IN_USE", "Desired user ID is already taken.");
        }
        const auth = body?.auth;
        const flows = [{ stages: ["m.login.registration_token", "m.login.dummy"] }];
        if (!auth?.session) {
          // First step of the UIA flow: challenge for the token + dummy stages.
          return json(res, 401, { session: "session-1", flows, params: {} });
        }
        state.registerStages.push({ username: localpart, type: auth.type });

        if (auth.type === "m.login.registration_token") {
          if (auth.token !== registrationToken) {
            return error(res, 401, "M_UNAUTHORIZED", "Invalid registration token");
          }
          // Token accepted; the dummy stage remains.
          return json(res, 401, {
            session: "session-1",
            completed: ["m.login.registration_token"],
            flows,
            params: {},
          });
        }

        if (auth.type === "m.login.dummy") {
          state.users.set(localpart, { password: body?.password });
          const token = `tok-${localpart}-${state.tokens.size + 1}`;
          state.tokens.set(token, localpart);
          return json(res, 200, {
            user_id: `@${localpart}:${serverName}`,
            access_token: token,
            device_id: "BOOTSTRAP",
          });
        }

        return error(res, 401, "M_UNAUTHORIZED", "Unexpected registration auth stage");
      }

      // --- room alias resolution ----------------------------------------
      const aliasMatch = pathname.match(/^\/_matrix\/client\/v3\/directory\/room\/(.+)$/);
      if (req.method === "GET" && aliasMatch) {
        const alias = decodeURIComponent(aliasMatch[1]);
        const roomId = state.aliases.get(alias);
        if (!roomId) return error(res, 404, "M_NOT_FOUND", "Room alias not found");
        return json(res, 200, { room_id: roomId, servers: [serverName] });
      }

      // --- room creation -------------------------------------------------
      if (req.method === "POST" && pathname === "/_matrix/client/v3/createRoom") {
        state.counts.createRoom++;
        const creator = actor() ?? "admin";
        const roomId = `!room${state.counts.createRoom}:${serverName}`;
        const alias = body?.room_alias_name ? `#${body.room_alias_name}:${serverName}` : null;
        const room = { roomId, alias, state: new Map(), members: new Map() };
        // Creator is a joined member.
        room.members.set(`@${creator}:${serverName}`, { membership: "join" });
        // Seed initial state from the request.
        for (const ev of body?.initial_state ?? []) {
          room.state.set(`${ev.type}\u0000${ev.state_key}`, ev.content);
        }
        // Seed power levels from power_level_content_override (approximation).
        if (body?.power_level_content_override) {
          room.state.set("m.room.power_levels\u0000", body.power_level_content_override);
        }
        if (body?.creation_content?.type === "m.space") {
          room.state.set("m.room.create\u0000", { type: "m.space" });
        }
        state.rooms.set(roomId, room);
        if (alias) state.aliases.set(alias, roomId);
        return json(res, 200, { room_id: roomId });
      }

      // --- media upload --------------------------------------------------
      if (req.method === "POST" && pathname === "/_matrix/media/v3/upload") {
        state.counts.upload++;
        state.mediaCount++;
        return json(res, 200, { content_uri: `mxc://${serverName}/seed-${state.mediaCount}` });
      }

      // --- invite --------------------------------------------------------
      const inviteMatch = pathname.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/invite$/);
      if (req.method === "POST" && inviteMatch) {
        state.counts.invite++;
        const roomId = decodeURIComponent(inviteMatch[1]);
        const room = state.rooms.get(roomId);
        if (!room) return error(res, 404, "M_NOT_FOUND", "Unknown room");
        const userId = body.user_id;
        const localpart = userId.startsWith("@") ? userId.slice(1).split(":")[0] : userId;
        if (!state.users.has(localpart)) {
          return error(res, 404, "M_NOT_FOUND", "User does not exist");
        }
        room.members.set(userId, { membership: "invite" });
        return json(res, 200, {});
      }

      // --- room state (read + write) ------------------------------------
      const stateMatch = pathname.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state\/([^/]+)\/(.*)$/);
      if (stateMatch) {
        const roomId = decodeURIComponent(stateMatch[1]);
        const type = decodeURIComponent(stateMatch[2]);
        const stateKey = decodeURIComponent(stateMatch[3]);
        const room = state.rooms.get(roomId);
        if (!room) return error(res, 404, "M_NOT_FOUND", "Unknown room");

        if (req.method === "GET") {
          // m.room.member is stored in members, not the generic state map.
          if (type === "m.room.member") {
            const member = room.members.get(stateKey);
            if (!member) return error(res, 404, "M_NOT_FOUND", "Not a member");
            return json(res, 200, member);
          }
          const content = room.state.get(`${type}\u0000${stateKey}`);
          if (content === undefined) return error(res, 404, "M_NOT_FOUND", "No state");
          return json(res, 200, content);
        }

        if (req.method === "PUT") {
          state.counts.putState++;
          room.state.set(`${type}\u0000${stateKey}`, body);
          return json(res, 200, { event_id: `$evt${state.counts.putState}:${serverName}` });
        }
      }

      // Fallthrough.
      return error(res, 404, "M_UNRECOGNIZED", `No mock handler for ${req.method} ${pathname}`);
    })().catch((err) => {
      error(res, 500, "M_UNKNOWN", String(err?.stack || err));
    });
  });

  return {
    server,
    state,
    start() {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      });
    },
    stop() {
      return new Promise((resolve) => server.close(resolve));
    },
    url(port) {
      return `http://127.0.0.1:${port}`;
    },
  };
}
