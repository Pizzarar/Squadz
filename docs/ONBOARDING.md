# Squadz onboarding

Welcome to Squadz — a private chat + voice space for the group. Everything runs
on a server that is only reachable over the group's private mesh, so you join the
mesh first, then sign up. This guide covers **Element X** (iPhone/Android) and
**Element** (desktop).

> **Host (Aub):** `node scripts/squadz.mjs invite --name <FRIEND>` prints a ready-to-paste version of this guide with a single-use token; the full deploy runbook is [DEPLOY.md](DEPLOY.md). The rest of this page is the friend-facing reference.

> Replace `<YOUR_DOMAIN>` and `<REGISTRATION_TOKEN>` below with the real values
> from the host (they live in the server's `.env`, never in this repo).

## 0. What you need from the host

Ask Aub (the server owner) for three things:

1. **Server name** — this is the chat address, `chat.<YOUR_DOMAIN>`.
2. **Mesh invite** — a Tailscale invite link (step 1; NordVPN Meshnet if the host uses it instead).
3. **Registration token** — the `<REGISTRATION_TOKEN>` you use to create your account (single-use, so it only works for you).

## 1. Join the mesh

The server is not on the public internet. Your device must be on the same
peer-to-peer mesh before Element can reach it.

**Tailscale** (default; NordVPN Meshnet works the same way if the host uses it):

1. Install Tailscale (https://tailscale.com/download) and sign in.
2. Accept the host's tailnet invite (or machine share) and switch the VPN on. For Meshnet: install NordVPN, accept the invite and enable mesh routing.
3. Check you can see the host's mesh device as "connected".

> On desktop, make sure the mesh app stays running (and "allow LAN/mesh traffic"
> is on). On phones, leave the mesh app installed; Element will route through it.

## 2. Pick your client

- **Phone:** install **Element X** from the App Store / Play Store.
- **Desktop (nothing to install):** with the mesh app connected, open
  `https://chat.<YOUR_DOMAIN>/` in Chrome, Edge or Firefox. That is the Squadz web
  client (Cinny): the server is already filled in and locked, so skip the "server name"
  step below. Click **Register**, pick a username and password, paste the registration
  token. Voice/video: open a room and use the call buttons in the header.
- **Desktop app (optional):** **Element** from element.io also works; follow the server
  steps below.

## 3. Create your account (sign up with the token)

1. Open Element and tap **Create account**.
2. When asked for a server, choose **Edit / Other** and enter the server name
   `chat.<YOUR_DOMAIN>` (or enter your full ID as `@<your-name>:chat.<YOUR_DOMAIN>`
   and let it auto-discover).
3. Choose your own username and a strong password.
4. When prompted for a **registration token**, paste `<REGISTRATION_TOKEN>`.
5. Verify your session (Element X will set up encryption keys — keep your recovery
   key/passphrase somewhere safe).

## 4. Join the Squadz space

Once signed in:

1. You should land in **Squadz** automatically. If not, accept the Space invite or open **Spaces**, and ask the host to run `squadz sync-members`.
2. Open **Squadz**. You'll see the rooms inside:
   - **General** — day-to-day chat
   - **Games** — game talk and scheduling
   - **Clips** — the soundboard bot (`!sb play <clip>`)
   - **Memes** — memes
   - **Lounge** and **Game Night** — voice rooms (see below)

> The rooms are **restricted** to Space members: once you've joined the Squadz
> space you can enter any of its rooms directly — you don't need a separate
> invite per room. (You only need the one invite to the Space.)

## 5. Start a voice call

**Lounge** and **Game Night** are set up as call rooms (MatrixRTC). To talk:

1. Open the room (**Lounge** or **Game Night**).
2. Tap the **call / voice** button in the header (or the "Join call" button).
3. Allow microphone/camera access when prompted.
4. People in the same room can hop in and out whenever — like a voice channel.

> Calls run end-to-end encrypted over the group's LiveKit SFU. If a call won't
> connect, check the mesh is still connected (step 1) and see the troubleshooting
> section at the end.

## 6. Use the custom emoji

The space ships a small custom emoji pack, set in the Space and every text room.
In any room:

1. Open the emoji picker (the smiley next to the message box).
2. Look under **custom emoji** for `:squadz:`, `:wave:`, `:party:`, `:gg:`.
3. Type `:squadz:` (or the start of a shortcode) to autocomplete.

Want your own emoji or sticker? Send the image (png, gif, webp or jpg, under 256KB
for an emoji, 512KB for a sticker) and the shortcode you want to Aub, who can add
it for everyone with `squadz emoji add`.

> Custom emoji are Matrix "image packs" (MSC2545). Support varies by client and
> version:
> - **The Squadz web client (Cinny, at `https://CHAT_FQDN/`)** shows the pack in
>   the emoji picker and renders the emotes inline. Element Web/Desktop has no
>   MSC2545 support (see docs/CLIENTS.md).
> - **Element X** can send and display custom emoji from packs, but the feature
>   is newer there and some builds only surface packs set directly in the room —
>   which is why Squadz sets the pack in every text room, not just the Space.
> - The pack still uses an unstable event type (`im.ponies.room_emotes`); the
>   stable `m.room.image_pack` is not widely deployed yet. On a client that
>   doesn't recognise the pack, the emote appears as an inline image instead.

## Troubleshooting

- **"Server not found / can't reach homeserver"** — the mesh is off, or you're not
  routed to the host. Reconnect the mesh app and try again.
- **"Invalid registration token"** — the token is wrong or expired; ask Aub for a
  fresh one.
- **Calls connect but no audio** — allow mic permission, and make sure you're on the
  same mesh as the host (calls use `rtc.<YOUR_DOMAIN>`; a broken mesh route breaks
  calls while chat still works).
- **Messages show as "unable to decrypt"** — your encryption keys are on another
  device; sign in with that device to cross-verify, or use your recovery key.

For server-side setup and network details (ports, DNS, mesh caveats), see
`docs/SETUP.md`.
