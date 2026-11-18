// scripts/lib/matrix.mjs
//
// A tiny Matrix Client-Server API client built on the built-in `fetch`.
// Only the endpoints bootstrap.mjs needs are implemented. No dependencies.

/** Error thrown for non-2xx Matrix API responses. */
export class MatrixError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string|undefined} errcode Matrix error code (e.g. M_FORBIDDEN)
   * @param {string|undefined} message Human-readable error string
   * @param {*} data Full parsed response body
   */
  constructor(status, errcode, message, data) {
    super(message || errcode || `HTTP ${status}`);
    this.name = "MatrixError";
    this.status = status;
    this.errcode = errcode;
    this.data = data;
  }
}

function enc(segment) {
  return encodeURIComponent(segment);
}

/**
 * Choose the registration UIA stages to complete, from the server's offered
 * flows. We support `m.login.registration_token` and `m.login.dummy`; pick the
 * first flow made up entirely of those stages. Returns the ordered stage list.
 */
function selectRegistrationStages(flows, registrationToken) {
  for (const flow of flows) {
    const stages = flow.stages ?? [];
    if (stages.length === 0) continue;
    if (stages.every((s) => s === "m.login.registration_token" || s === "m.login.dummy")) {
      if (stages.includes("m.login.registration_token") && !registrationToken) {
        throw new MatrixError(
          401,
          "M_FORBIDDEN",
          "TUWUNEL_REGISTRATION_TOKEN is required to register",
          null,
        );
      }
      return stages;
    }
  }
  throw new MatrixError(
    401,
    "M_FORBIDDEN",
    "Server requires an unsupported registration flow",
    { flows },
  );
}

/**
 * Create a Matrix CS API client. After login/register, set `client.token` to
 * authenticate subsequent calls.
 *
 * @param {string} baseUrl Homeserver base URL, e.g. "https://chat.example.com"
 */
export function createMatrixClient(baseUrl) {
  const client = {
    baseUrl,
    token: null,

    /**
     * Perform a raw API request.
     * @param {string} method
     * @param {string} path Absolute path beginning with "/_matrix/..."
     * @param {object} [opts]
     * @param {*} [opts.body] JSON-serialisable body, or raw bytes when contentType is given
     * @param {string} [opts.contentType] If set, body is sent verbatim with this Content-Type
     * @param {boolean} [opts.raw] If true, resolve with the raw Response instead of parsed JSON
     */
    async request(method, path, opts = {}) {
      const { body, contentType } = opts;
      const headers = {};
      if (client.token) headers.Authorization = `Bearer ${client.token}`;

      let payload;
      if (body !== undefined) {
        if (contentType && contentType !== "application/json") {
          headers["Content-Type"] = contentType;
          payload = body;
        } else {
          headers["Content-Type"] = "application/json";
          payload = JSON.stringify(body);
        }
      }

      const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });

      if (opts.raw) return res;

      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      if (!res.ok) {
        const obj = data && typeof data === "object" ? data : {};
        throw new MatrixError(res.status, obj.errcode, obj.error, data);
      }
      return data;
    },

    // --- Auth ------------------------------------------------------------

    /** @returns {{ user_id: string, access_token: string, device_id?: string }} */
    async login(localpart, password) {
      return client.request("POST", "/_matrix/client/v3/login", {
        body: {
          type: "m.login.password",
          identifier: { type: "m.id.user", user: localpart },
          password,
        },
      });
    },

    /**
     * Register a new user using User-Interactive Authentication (Matrix spec).
     * The server may demand several stages in sequence (e.g. the
     * `m.login.registration_token` stage, then a `m.login.dummy` stage), so we
     * drive each stage in turn until the server accepts. Throws MatrixError
     * with errcode M_USER_IN_USE if the username is already taken.
     *
     * @returns {{ user_id: string, access_token: string }}
     */
    async register(localpart, password, registrationToken) {
      const body = { username: localpart, password };

      // 1. First attempt without auth: open registration accepts immediately.
      let challenge;
      try {
        await client.request("POST", "/_matrix/client/v3/register", { body });
        // No UIA required — the server already registered us. Log in for a token.
        return client.login(localpart, password);
      } catch (err) {
        if (!(err instanceof MatrixError) || err.status !== 401 || !err.data?.session) {
          throw err;
        }
        challenge = err.data;
      }

      // 2. Pick a flow we can complete (registration token and/or dummy stages).
      const stages = selectRegistrationStages(challenge.flows ?? [], registrationToken);

      // 3. Complete each stage. A 401 with a session means "stage accepted,
      //    keep going"; the final success returns user_id + access_token.
      let session = challenge.session;
      for (const stage of stages) {
        const auth = { type: stage, session };
        if (stage === "m.login.registration_token") auth.token = registrationToken;
        try {
          return await client.request("POST", "/_matrix/client/v3/register", {
            body: { ...body, auth },
          });
        } catch (err) {
          if (err instanceof MatrixError && err.status === 401 && err.data?.session) {
            session = err.data.session;
            continue;
          }
          throw err;
        }
      }

      throw new MatrixError(
        401,
        "M_FORBIDDEN",
        "Registration flow could not be completed",
        challenge,
      );
    },

    // --- Rooms -----------------------------------------------------------

    /** @returns {{ room_id: string }} */
    createRoom(payload) {
      return client.request("POST", "/_matrix/client/v3/createRoom", { body: payload });
    },

    /**
     * Resolve a room alias to a room ID, or null if the alias does not exist.
     * @returns {Promise<string|null>}
     */
    async resolveAlias(alias) {
      try {
        const data = await client.request("GET", `/_matrix/client/v3/directory/room/${enc(alias)}`);
        return data.room_id ?? null;
      } catch (err) {
        if (err instanceof MatrixError && err.status === 404) return null;
        throw err;
      }
    },

    // --- State -----------------------------------------------------------

    /** @returns {{ event_id: string }} */
    putState(roomId, type, stateKey, content) {
      return client.request(
        "PUT",
        `/_matrix/client/v3/rooms/${enc(roomId)}/state/${enc(type)}/${enc(stateKey)}`,
        { body: content },
      );
    },

    /** @returns {object|null} Current state content, or null if not set. */
    async getState(roomId, type, stateKey) {
      try {
        return await client.request(
          "GET",
          `/_matrix/client/v3/rooms/${enc(roomId)}/state/${enc(type)}/${enc(stateKey)}`,
        );
      } catch (err) {
        if (err instanceof MatrixError && err.status === 404) return null;
        throw err;
      }
    },

    // --- Membership ------------------------------------------------------

    /** @returns {object|null} m.room.member content, or null if not a member. */
    async getMember(roomId, userId) {
      try {
        return await client.request(
          "GET",
          `/_matrix/client/v3/rooms/${enc(roomId)}/state/m.room.member/${enc(userId)}`,
        );
      } catch (err) {
        if (err instanceof MatrixError && err.status === 404) return null;
        throw err;
      }
    },

    /** @returns {object} Empty object on success. */
    invite(roomId, userId) {
      return client.request("POST", `/_matrix/client/v3/rooms/${enc(roomId)}/invite`, {
        body: { user_id: userId },
      });
    },


    // --- Messages / profile (ops CLI) -------------------------------------

    /** Send an m.text message. @returns {{ event_id: string }} */
    sendText(roomId, body, txnId = `squadz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) {
      return client.request(
        "PUT",
        `/_matrix/client/v3/rooms/${enc(roomId)}/send/m.room.message/${enc(txnId)}`,
        { body: { msgtype: "m.text", body } },
      );
    },

    /** Newest-first room timeline. @returns {{ chunk: object[] }} */
    messages(roomId, limit = 20) {
      return client.request(
        "GET",
        `/_matrix/client/v3/rooms/${enc(roomId)}/messages?dir=b&limit=${limit}`,
      );
    },

    /** @returns {object|null} Profile, or null if the user does not exist. */
    async getProfile(userId) {
      try {
        return await client.request("GET", `/_matrix/client/v3/profile/${enc(userId)}`);
      } catch (err) {
        if (err instanceof MatrixError && (err.status === 404 || err.errcode === "M_NOT_FOUND")) return null;
        throw err;
      }
    },

    // --- Media -----------------------------------------------------------

    /** @returns {{ content_uri: string }} */
    upload(filename, bytes, contentType) {
      return client.request(
        "POST",
        `/_matrix/media/v3/upload?filename=${enc(filename)}`,
        { body: bytes, contentType },
      );
    },
  };

  return client;
}
