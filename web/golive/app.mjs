// DOM wiring + state machine: login -> lobby -> streaming | watching.
import { login, resolveRoom, openidToken, resolveLivekitServiceUrl, sendCallMember, clearCallMember, serverNameFromUserId, defaultRoomAliases, roomFromSearch, prefillRoom } from './lib/matrix.mjs';
import { fetchSfuToken } from './lib/lkjwt.mjs';
import { startCapture } from './lib/capture.mjs';
import { publish, stop, watch, videoStats } from './lib/publish.mjs';

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 3 * 60 * 60 * 1000; // refresh call.member before its 4 h expiry
const s = { homeserver: window.location.origin, session: null, room: null, stream: null, roomId: null, lkUrl: null, timers: [] };

function show(view) {
  document.querySelectorAll('[data-view]').forEach((el) => { el.hidden = el.dataset.view !== view; });
}
function err(e) {
  const el = $('error');
  el.textContent = e ? (e.message || String(e)) : '';
  el.hidden = !e;
}
const guard = (fn) => async () => { err(null); try { await fn(); } catch (e) { err(e); } };

$('homeserver').value = s.homeserver;

$('btn-login').onclick = guard(async () => {
  s.homeserver = $('homeserver').value.replace(/\/+$/, '');
  s.session = await login(s.homeserver, $('username').value.trim(), $('password').value);
  $('password').value = '';
  $('who').textContent = s.session.userId;
  const sel = $('room-select');
  sel.replaceChildren(...defaultRoomAliases(serverNameFromUserId(s.session.userId)).map((a) => new Option(a, a)));
  prefillRoom(roomFromSearch(window.location.search), sel, $('room-custom')); // /golive?room=<id|alias>
  show('lobby');
});

document.querySelectorAll('input[name=mode]').forEach((r) => {
  r.onchange = () => { $('stream-opts').hidden = document.querySelector('input[name=mode]:checked').value === 'watch'; };
});

$('btn-test').onclick = guard(async () => {
  const c = await startCapture($('preset').value);
  const st = c.settings;
  $('test-result').textContent = `${st.width}x${st.height} @ ${Math.round(st.frameRate || 0)} fps, audio track: ${c.hasAudio ? 'yes' : 'NO (tick "share audio" / pick a tab or screen that supports it)'}`;
  c.stream.getTracks().forEach((t) => t.stop());
});

async function connectInfo() {
  const pick = $('room-custom').value.trim() || $('room-select').value;
  const { homeserver: hs, session: me } = s;
  s.roomId = await resolveRoom(hs, pick, me.accessToken);
  s.lkUrl = await resolveLivekitServiceUrl(hs);
  const tok = await openidToken(hs, me.userId, me.accessToken);
  return fetchSfuToken({ livekitServiceUrl: s.lkUrl, roomId: s.roomId, openIdToken: tok, deviceId: me.deviceId });
}

const memberArgs = () => ({ homeserver: s.homeserver, roomId: s.roomId, userId: s.session.userId, deviceId: s.session.deviceId, token: s.session.accessToken });

function clearTimers() { s.timers.forEach(clearInterval); s.timers = []; }

async function endStream() {
  clearTimers();
  const { room, stream } = s;
  s.room = s.stream = null;
  try { await stop(room, stream); } catch { /* already gone */ }
  try { if (s.roomId) await clearCallMember(memberArgs()); } catch (e) { err(e); }
  $('preview').srcObject = null;
  show('lobby');
}

$('btn-go').onclick = guard(async () => {
  if (document.querySelector('input[name=mode]:checked').value === 'watch') return startWatching();
  const preset = $('preset').value, codec = $('codec').value;
  // Capture first: the user gesture is needed for getDisplayMedia.
  const cap = await startCapture(preset);
  try {
    const { url, jwt } = await connectInfo();
    await sendCallMember({ ...memberArgs(), livekitServiceUrl: s.lkUrl }); // throws a clear error on missing power
    s.stream = cap.stream;
    s.room = await publish({ url, jwt, stream: cap.stream, preset, codec, onEnded: () => { if (s.room) guard(endStream)(); } });
  } catch (e) {
    cap.stream.getTracks().forEach((t) => t.stop());
    s.stream = s.room = null;
    try { await clearCallMember(memberArgs()); } catch { /* may never have been sent */ }
    throw e;
  }
  $('preview').srcObject = cap.stream;
  $('st-audio').textContent = cap.hasAudio ? 'yes' : 'NO';
  show('streaming');
  s.timers.push(setInterval(() => sendCallMember({ ...memberArgs(), livekitServiceUrl: s.lkUrl }).catch(err), REFRESH_MS));
  s.timers.push(setInterval(async () => {
    const st = s.room && (await videoStats(s.room).catch(() => null));
    const t = cap.stream.getVideoTracks()[0].getSettings();
    $('st-res').textContent = `${(st && st.w) || t.width}x${(st && st.h) || t.height}`;
    $('st-fps').textContent = st && st.fps ? Math.round(st.fps) : Math.round(t.frameRate || 0);
    $('st-br').textContent = st && st.bitrate ? `${(st.bitrate / 1e6).toFixed(1)} Mbps` : '-';
  }, 1000));
});
$('btn-stop').onclick = guard(endStream);

async function startWatching() {
  const { url, jwt } = await connectInfo();
  const grid = $('grid');
  grid.replaceChildren();
  s.room = await watch({
    url, jwt,
    onTrack(track, participant) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      tile.dataset.sid = track.sid;
      const el = track.attach();
      if (track.kind === 'video') el.playsInline = true;
      const cap = document.createElement('label');
      cap.textContent = participant.identity;
      if (track.kind === 'audio') {
        const vol = Object.assign(document.createElement('input'), { type: 'range', min: 0, max: 1, step: 0.01, value: 1 });
        vol.oninput = () => { el.volume = Number(vol.value); };
        cap.append(' volume ', vol);
      }
      tile.append(el, cap);
      grid.append(tile);
    },
    onRemoved(track) {
      track.detach().forEach((e) => e.remove());
      grid.querySelector(`[data-sid="${track.sid}"]`)?.remove();
    },
    onEnded: () => { if (s.room) { s.room = null; $('grid').replaceChildren(); show('lobby'); } },
  });
  show('watching'); // viewers never send call.member
}
$('btn-leave').onclick = guard(async () => {
  const room = s.room;
  s.room = null;
  if (room) await room.disconnect();
  $('grid').replaceChildren();
  show('lobby');
});

window.addEventListener('pagehide', () => {
  clearTimers();
  const { room, stream } = s;
  s.room = s.stream = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (stream && s.session && s.roomId) clearCallMember({ ...memberArgs(), keepalive: true }).catch(() => {});
  if (room) room.disconnect();
});
show('login');
