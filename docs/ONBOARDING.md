# Squadz onboarding

Welcome to Squadz — a private chat + voice space for the group. Everything runs
on a server that is only reachable over the group's private mesh, so you join the
mesh first, then sign up. This guide covers **Element X** (iPhone/Android) and
**Element** (desktop).

> Replace `<YOUR_DOMAIN>` and `<REGISTRATION_TOKEN>` below with the real values
> from the host (they live in the server's `.env`, never in this repo).

## 0. What you need from the host

Ask Aub (the server owner) for three things:

1. **Server name** — this is the chat address, `chat.<YOUR_DOMAIN>`.
2. **Mesh invite** — an invite link/code for NordVPN Meshnet or Tailscale (step 1).
3. **Registration token** — the `<REGISTRATION_TOKEN>` you use to create your account.

## 1. Join the mesh

The server is not on the public internet. Your device must be on the same
peer-to-peer mesh before Element can reach it.

**NordVPN Meshnet** (or **Tailscale**, whichever the host uses):

1. Install the app and sign in.
2. Accept the host's invite and enable mesh traffic routing on the device.
3. Check you can see the host's mesh device as "connected".

> On desktop, make sure the mesh app stays running (and "allow LAN/mesh traffic"
> is on). On phones, leave the mesh app installed; Element will route through it.

## 2. Install Element

- **Phone:** install **Element X** from the App Store / Play Store.
- **Desktop:** install **Element** from element.io (or your package manager).

## 3. Create your account (sign up with the token)

1. Open Element and tap **Create account**.
2. When asked for a server, choose **Edit / Other** and enter the server name
   `chat.<YOUR_DOMAIN>` (or enter your full ID as `@<your-name>:chat.<YOUR_DOMAIN>`
   and let it auto-discover).
3. Choose a username and a strong password.
4. When prompted for a **registration token**, paste `<REGISTRATION_TOKEN>`.
5. Verify your session (Element X will set up encryption keys — keep your recovery
   key/passphrase somewhere safe).

## 4. Join the Squadz space

Once signed in:

1. Tap the **invite** you received (or open **Spaces** / the `+` menu).
2. Join **Squadz**. You'll see the rooms inside:
   - **General** — day-to-day chat
   - **Games** — game talk and scheduling
   - **Clips** — the soundboard bot (`!sb play <clip>`)
   - **Memes** — memes
   - **Lounge** and **Game Night** — voice rooms (see below)

> Rooms are invite-only, so join from the invites Aub sent you.

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

The space ships a small custom emoji pack. In any room:

1. Open the emoji picker (the smiley next to the message box).
2. Look under **custom emoji / space** for `:squadz:`, `:wave:`, `:party:`, `:gg:`.
3. Type `:squadz:` (or the start of a shortcode) to autocomplete.

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
