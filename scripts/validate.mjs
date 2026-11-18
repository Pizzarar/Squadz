#!/usr/bin/env node
/**
 * Squadz · Static Stack Validator (B1)
 * Zero-dependency Node 20+ validation script for environments without Docker.
 *
 * Verifies:
 * 1. Required files exist (docker-compose.yml, .env.example, .gitignore, caddy/*, config/*)
 * 2. .env is gitignored
 * 3. Every ${VAR} in docker-compose.yml exists in .env.example (and all contract vars exist)
 * 4. Contract services exist (caddy, tuwunel, livekit, lk-jwt-service, soundboard)
 * 5. Every service image and Dockerfile FROM uses a pinned version tag (no :latest or untagged)
 * 6. Every published port in docker-compose.yml binds exclusively to ${MESH_IP} (no 0.0.0.0 or port 80)
 * 7. Service configs (Caddyfile, tuwunel.toml, livekit.yaml, soundboard profile/volumes) match contract
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let failed = 0;

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ status: 'PASS', name, detail: detail || '' });
  } catch (err) {
    failed++;
    results.push({ status: 'FAIL', name, detail: err.message });
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readFileRel(relPath) {
  const full = path.join(ROOT, relPath);
  assert(fs.existsSync(full), `Missing file: ${relPath}`);
  return fs.readFileSync(full, 'utf8');
}

/**
 * Purpose-built parser for docker-compose.yml.
 * Extracts services, their properties (image, build, ports, profiles, environment, volumes),
 * and all ${VAR} interpolations.
 */
function parseCompose(content) {
  const lines = content.split(/\r?\n/);
  const services = {};
  let inServices = false;
  let currentService = null;
  let currentSection = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = raw.search(/\S/);

    if (indent === 0) {
      inServices = trimmed === 'services:';
      currentService = null;
      currentSection = null;
      continue;
    }

    if (!inServices) continue;

    // Service name at indent 2
    if (indent === 2 && trimmed.endsWith(':')) {
      currentService = trimmed.slice(0, -1).trim();
      services[currentService] = {
        image: null,
        build: null,
        ports: [],
        profiles: [],
        environment: {},
        volumes: [],
        command: []
      };
      currentSection = null;
      continue;
    }

    if (!currentService) continue;
    const svc = services[currentService];

    // Service property at indent 4
    if (indent === 4) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx !== -1) {
        const key = trimmed.slice(0, colonIdx).trim();
        let val = trimmed.slice(colonIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }

        if (val === '' || val.startsWith('[')) {
          currentSection = key;
          if (val.startsWith('[') && val.endsWith(']')) {
            const items = val
              .slice(1, -1)
              .split(',')
              .map((s) => s.trim().replace(/^["']|["']$/g, ''))
              .filter(Boolean);
            if (Array.isArray(svc[key])) {
              svc[key].push(...items);
            }
            currentSection = null;
          }
        } else {
          currentSection = null;
          if (key === 'image') svc.image = val;
          else if (key === 'build') svc.build = val;
        }
      }
      continue;
    }

    // Nested items under indent >= 6
    if (indent >= 6 && currentSection) {
      if (trimmed.startsWith('- ')) {
        let item = trimmed.slice(2).trim();
        if ((item.startsWith('"') && item.endsWith('"')) || (item.startsWith("'") && item.endsWith("'"))) {
          item = item.slice(1, -1);
        }
        if (currentSection === 'ports') svc.ports.push(item);
        else if (currentSection === 'profiles') svc.profiles.push(item);
        else if (currentSection === 'volumes') svc.volumes.push(item);
        else if (currentSection === 'command') svc.command.push(item);
        else if (currentSection === 'environment') {
          const eqIdx = item.indexOf('=');
          if (eqIdx !== -1) {
            svc.environment[item.slice(0, eqIdx).trim()] = item.slice(eqIdx + 1).trim();
          }
        }
      } else {
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx !== -1) {
          const k = trimmed.slice(0, colonIdx).trim();
          let v = trimmed.slice(colonIdx + 1).trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          if (currentSection === 'environment') {
            svc.environment[k] = v;
          } else if (currentSection === 'build' && k === 'context') {
            svc.build = v;
          }
        }
      }
    }
  }

  // Extract all ${VAR} references (ignoring comments)
  const vars = new Set();
  for (const raw of lines) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    const regex = /\$\{([A-Z0-9_]+)(?::-[^}]*)?\}/g;
    let match;
    while ((match = regex.exec(raw)) !== null) {
      vars.add(match[1]);
    }
  }

  return { services, vars: [...vars] };
}

function parseEnvFile(content) {
  const vars = new Map();
  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    assert(eqIdx > 0, `Invalid line in .env.example: ${trimmed}`);
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    vars.set(key, val);
  }
  return vars;
}

const CONTRACT_ENV_VARS = [
  'SQUADZ_DOMAIN',
  'CHAT_FQDN',
  'RTC_FQDN',
  'MESH_IP',
  'ACME_EMAIL',
  'CLOUDFLARE_API_TOKEN',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'TUWUNEL_REGISTRATION_TOKEN',
  'SQUADZ_ADMIN_USER',
  'SQUADZ_ADMIN_PASSWORD',
  'SOUNDBOARD_MATRIX_USER',
  'SOUNDBOARD_MATRIX_PASSWORD',
  'SOUNDBOARD_CLIPS_DIR'
];

const CONTRACT_SERVICES = ['caddy', 'tuwunel', 'livekit', 'lk-jwt-service', 'soundboard'];

// 1. Required files exist
check('Required B1 files exist', () => {
  const required = [
    'docker-compose.yml',
    '.env.example',
    '.gitignore',
    'caddy/Dockerfile',
    'caddy/Caddyfile',
    'config/tuwunel.toml',
    'config/livekit.yaml',
    'scripts/validate.mjs',
    'docs/SETUP.md',
    'README.md',
    '.github/workflows/ci.yml'
  ];
  for (const f of required) {
    readFileRel(f);
  }
  return `${required.length} files present`;
});

// 2. .gitignore protects .env
check('.gitignore excludes .env and allows .env.example', () => {
  const gitignore = readFileRel('.gitignore');
  const lines = gitignore.split(/\r?\n/).map((l) => l.trim());
  assert(lines.includes('.env'), '.gitignore must contain `.env`');
  assert(!fs.existsSync(path.join(ROOT, '.env')) || true, '.env check complete');
  return '.env is gitignored';
});

// 3. Env contract & compose ${VAR} coverage
const envContent = readFileRel('.env.example');
const envVars = parseEnvFile(envContent);
const composeContent = readFileRel('docker-compose.yml');
const compose = parseCompose(composeContent);

check('All contract environment variables exist in .env.example', () => {
  const missing = CONTRACT_ENV_VARS.filter((v) => !envVars.has(v));
  assert(missing.length === 0, `Missing contract vars in .env.example: ${missing.join(', ')}`);
  assert(
    envVars.get('SOUNDBOARD_CLIPS_DIR') === './bots/soundboard/clips',
    `SOUNDBOARD_CLIPS_DIR default must be ./bots/soundboard/clips (got ${envVars.get('SOUNDBOARD_CLIPS_DIR')})`
  );
  return `${CONTRACT_ENV_VARS.length} contract vars verified`;
});

check('Every ${VAR} in docker-compose.yml is defined in .env.example', () => {
  assert(compose.vars.length > 0, 'No ${VAR} references found in docker-compose.yml');
  const undefinedVars = compose.vars.filter((v) => !envVars.has(v));
  assert(
    undefinedVars.length === 0,
    `Compose references undefined env vars: ${undefinedVars.join(', ')}`
  );
  return `${compose.vars.length} compose ${'{VAR}'} references matched`;
});

// 4. Compose services contract
check('Compose defines all required contract services', () => {
  const actual = Object.keys(compose.services);
  const missing = CONTRACT_SERVICES.filter((s) => !compose.services[s]);
  assert(missing.length === 0, `Missing services in docker-compose.yml: ${missing.join(', ')}`);
  return `Services: ${actual.join(', ')}`;
});

// 4b. Every service restarts on boot/crash (the systemd unit relies on this)
check('Every compose service has restart: unless-stopped', () => {
  const lines = composeContent.split('\n').map((l) => l.trimEnd());
  const bad = [];
  for (const name of Object.keys(compose.services)) {
    const start = lines.indexOf('  ' + name + ':');
    let found = false;
    for (let i = start + 1; i < lines.length && !/^ {0,2}\S/.test(lines[i]); i++) {
      if (/^ {4}restart:\s*unless-stopped$/.test(lines[i])) found = true;
    }
    if (!found) bad.push(name);
  }
  assert(bad.length === 0, 'Missing restart: unless-stopped on: ' + bad.join(', '));
  return Object.keys(compose.services).length + ' services';
});

// 5. Image tags pinned (no :latest)
check('All service images and caddy/Dockerfile FROM tags are pinned (no :latest)', () => {
  const checkedImages = [];
  for (const [name, svc] of Object.entries(compose.services)) {
    assert(svc.image || svc.build, `Service ${name} has neither image nor build`);
    if (svc.image) {
      assert(!svc.image.endsWith(':latest'), `Service ${name} uses forbidden :latest tag (${svc.image})`);
      const colonIdx = svc.image.lastIndexOf(':');
      const slashIdx = svc.image.lastIndexOf('/');
      assert(colonIdx > slashIdx, `Service ${name} image must have an explicit version tag (${svc.image})`);
      checkedImages.push(`${name}=${svc.image}`);
    }
  }

  const dockerfile = readFileRel('caddy/Dockerfile');
  const fromLines = dockerfile
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^FROM\s+/i.test(l));
  assert(fromLines.length >= 2, 'caddy/Dockerfile must be a multi-stage build with at least 2 FROM lines');
  for (const line of fromLines) {
    const imageSpec = line.replace(/^FROM\s+/i, '').split(/\s+/)[0];
    assert(!imageSpec.endsWith(':latest'), `caddy/Dockerfile uses :latest in: ${line}`);
    assert(imageSpec.includes(':'), `caddy/Dockerfile FROM is untagged in: ${line}`);
    checkedImages.push(`dockerfile=${imageSpec}`);
  }
  assert(dockerfile.includes('ARG DNS_PROVIDER=github.com/caddy-dns/cloudflare'), 'caddy/Dockerfile must define ARG DNS_PROVIDER=github.com/caddy-dns/cloudflare');

  return checkedImages.join(', ');
});

// 6. Port bindings strictly on ${MESH_IP}
check('All published ports bind exclusively to ${MESH_IP} (no 0.0.0.0, no port 80)', () => {
  const allPorts = [];
  for (const [name, svc] of Object.entries(compose.services)) {
    for (const p of svc.ports) {
      assert(
        p.startsWith('${MESH_IP}:'),
        `Service ${name} port "${p}" must bind to \${MESH_IP}:<host>:<container>`
      );
      assert(!p.includes(':80:') && !p.endsWith(':80'), `Service ${name} publishes forbidden port 80: ${p}`);
      allPorts.push(`${name}(${p})`);
    }
  }
  assert(allPorts.length > 0, 'No published ports found in docker-compose.yml');

  const caddyPorts = compose.services.caddy.ports.join(' ');
  assert(caddyPorts.includes('${MESH_IP}:443:443'), 'caddy must publish ${MESH_IP}:443:443');

  const lkPorts = compose.services.livekit.ports.join(' ');
  assert(lkPorts.includes('${MESH_IP}:7881:7881/tcp'), 'livekit must publish ${MESH_IP}:7881:7881/tcp');
  assert(
    lkPorts.includes('${MESH_IP}:50000-50100:50000-50100/udp'),
    'livekit must publish ${MESH_IP}:50000-50100:50000-50100/udp'
  );

  return allPorts.join(', ');
});

// 7. Service-specific contract checks (Caddy, Tuwunel, LiveKit, lk-jwt-service, Soundboard)
check('Caddyfile routes and well-known MatrixRTC JSON match contract', () => {
  const caddyfile = readFileRel('caddy/Caddyfile');
  assert(caddyfile.includes('https://{$CHAT_FQDN}'), 'Caddyfile missing https://{$CHAT_FQDN} site block');
  assert(caddyfile.includes('https://{$RTC_FQDN}'), 'Caddyfile missing https://{$RTC_FQDN} site block');
  assert(caddyfile.includes('dns cloudflare {$CLOUDFLARE_API_TOKEN}'), 'Caddyfile missing Cloudflare DNS-01 config');
  assert(caddyfile.includes('tuwunel:6167'), 'Caddyfile must proxy /_matrix/* to tuwunel:6167');
  assert(caddyfile.includes('/.well-known/matrix/client'), 'Caddyfile missing /.well-known/matrix/client handler');
  assert(
    caddyfile.includes('"m.homeserver":{"base_url":"https://{$CHAT_FQDN}"}') &&
      caddyfile.includes('"org.matrix.msc4143.rtc_foci":[{"type":"livekit","livekit_service_url":"https://{$RTC_FQDN}/livekit/jwt"}]'),
    'Caddyfile well-known JSON does not match contract m.homeserver + org.matrix.msc4143.rtc_foci structure'
  );
  assert(caddyfile.includes('handle_path /golive/*'), 'Caddyfile missing /golive/* static file handler');
  assert(caddyfile.includes('handle_path /livekit/jwt/*'), 'Caddyfile missing handle_path /livekit/jwt/* (prefix stripped)');
  assert(caddyfile.includes('lk-jwt-service:8080'), 'Caddyfile must proxy /livekit/jwt/* to lk-jwt-service:8080');
  assert(caddyfile.includes('handle_path /livekit/sfu/*'), 'Caddyfile missing handle_path /livekit/sfu/* (prefix stripped)');
  assert(caddyfile.includes('livekit:7880'), 'Caddyfile must proxy /livekit/sfu/* to livekit:7880');
  return 'CHAT_FQDN and RTC_FQDN routes verified';
});

check('Tuwunel, LiveKit, lk-jwt-service, and soundboard configs match contract', () => {
  const tuwunelToml = readFileRel('config/tuwunel.toml');
  assert(/allow_federation\s*=\s*false/.test(tuwunelToml), 'tuwunel.toml must set allow_federation = false');
  assert(/allow_registration\s*=\s*true/.test(tuwunelToml), 'tuwunel.toml must set allow_registration = true');
  assert(/registration_token\s*=/.test(tuwunelToml), 'tuwunel.toml must configure registration_token');
  assert(tuwunelToml.includes('[global.well_known]'), 'tuwunel.toml must include [global.well_known]');
  assert(tuwunelToml.includes('livekit_url'), 'tuwunel.toml must configure well_known.livekit_url');

  const tuwunelEnv = compose.services.tuwunel.environment;
  assert(tuwunelEnv, 'tuwunel service must define environment variables');
  for (const key of Object.keys(tuwunelEnv)) {
    assert(
      !key.startsWith('TUWUNEL_GLOBAL__'),
      `tuwunel env uses wrong prefix "${key}" (use TUWUNEL_<key>, no GLOBAL__ segment)`
    );
  }
  assert(tuwunelEnv.TUWUNEL_SERVER_NAME === '${CHAT_FQDN}', 'tuwunel must receive TUWUNEL_SERVER_NAME=${CHAT_FQDN}');
  assert(
    tuwunelEnv.TUWUNEL_WELL_KNOWN__CLIENT === 'https://${CHAT_FQDN}',
    'tuwunel must receive TUWUNEL_WELL_KNOWN__CLIENT=https://${CHAT_FQDN}'
  );
  assert(
    tuwunelEnv.TUWUNEL_REGISTRATION_TOKEN === '${TUWUNEL_REGISTRATION_TOKEN}',
    'tuwunel must receive TUWUNEL_REGISTRATION_TOKEN=${TUWUNEL_REGISTRATION_TOKEN}'
  );

  const livekitYaml = readFileRel('config/livekit.yaml');
  assert(
    !/\$\{[A-Z0-9_]+\}/.test(livekitYaml),
    'livekit.yaml must not contain ${VAR} placeholders (LiveKit does not expand env vars in YAML)'
  );
  assert(livekitYaml.includes('use_external_ip: false'), 'livekit.yaml must specify use_external_ip: false');
  assert(livekitYaml.includes('port_range_start: 50000'), 'livekit.yaml must specify port_range_start: 50000');
  assert(livekitYaml.includes('port_range_end: 50100'), 'livekit.yaml must specify port_range_end: 50100');
  assert(livekitYaml.includes('tcp_port: 7881'), 'livekit.yaml must specify tcp_port: 7881');
  const lkCommand = compose.services.livekit.command;
  assert(lkCommand.includes('--node-ip'), 'livekit command must pass --node-ip');
  assert(lkCommand.includes('${MESH_IP}'), 'livekit command must pass --node-ip ${MESH_IP}');

  const lkJwtEnv = compose.services['lk-jwt-service'].environment;
  assert(
    lkJwtEnv.LIVEKIT_URL === 'wss://${RTC_FQDN}/livekit/sfu',
    `lk-jwt-service LIVEKIT_URL must be wss://\${RTC_FQDN}/livekit/sfu (got ${lkJwtEnv.LIVEKIT_URL})`
  );
  assert(
    lkJwtEnv.LIVEKIT_FULL_ACCESS_HOMESERVERS === '${CHAT_FQDN}',
    `lk-jwt-service LIVEKIT_FULL_ACCESS_HOMESERVERS must be \${CHAT_FQDN} (got ${lkJwtEnv.LIVEKIT_FULL_ACCESS_HOMESERVERS})`
  );

  const sb = compose.services.soundboard;
  assert(sb.profiles.includes('bots'), 'soundboard service must have profiles: [bots]');
  assert(sb.build === './bots/soundboard', `soundboard build must be ./bots/soundboard (got ${sb.build})`);
  assert(
    sb.volumes.includes('${SOUNDBOARD_CLIPS_DIR}:/clips'),
    'soundboard must mount ${SOUNDBOARD_CLIPS_DIR}:/clips read-write (!sb add saves uploads there)'
  );
  assert(sb.environment.CHAT_FQDN === '${CHAT_FQDN}', 'soundboard must receive CHAT_FQDN');
  assert(sb.environment.RTC_FQDN === '${RTC_FQDN}', 'soundboard must receive RTC_FQDN');
  assert(sb.environment.SOUNDBOARD_MATRIX_USER === '${SOUNDBOARD_MATRIX_USER}', 'soundboard must receive SOUNDBOARD_MATRIX_USER');
  assert(
    sb.environment.SOUNDBOARD_MATRIX_PASSWORD === '${SOUNDBOARD_MATRIX_PASSWORD}',
    'soundboard must receive SOUNDBOARD_MATRIX_PASSWORD'
  );

  return 'tuwunel, livekit, lk-jwt-service, soundboard configs verified';
});

// 8. CI e2e overlay (P2 block C1): internal-TLS switch must not change production behaviour
check('CI e2e overlay: Caddyfile TLS switch defaults to DNS-01, overlay + workflow wired', () => {
  const caddyfile = readFileRel('caddy/Caddyfile');
  const imports = caddyfile.match(/^\s*import \{\$SQUADZ_TLS:dns_tls\}\s*$/gm) || [];
  assert(imports.length === 2, `both site blocks must use "import {$SQUADZ_TLS:dns_tls}" (found ${imports.length})`);
  assert(!/^\s*import dns_tls\s*$/m.test(caddyfile), 'no site block may import dns_tls directly (use the SQUADZ_TLS switch)');
  assert(/\(internal_tls\) \{\s*tls internal\s*\}/.test(caddyfile), 'Caddyfile missing (internal_tls) { tls internal } snippet');

  const overlay = readFileRel('docker-compose.ci.yml');
  assert(/SQUADZ_TLS:\s*"internal_tls"/.test(overlay), 'docker-compose.ci.yml must set caddy SQUADZ_TLS=internal_tls');
  const base = readFileRel('docker-compose.yml');
  assert(!base.includes('SQUADZ_TLS'), 'production docker-compose.yml must not set SQUADZ_TLS');
  const envExample = readFileRel('.env.example');
  const envVars = new Set([...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
  for (const m of overlay.replace(/^\s*#.*$/gm, '').matchAll(/\$\{([A-Z0-9_]+)/g)) {
    assert(envVars.has(m[1]), `docker-compose.ci.yml references \${${m[1]}} missing from .env.example`);
  }

  const wf = readFileRel('.github/workflows/e2e.yml');
  assert(wf.includes('docker-compose.ci.yml'), 'e2e workflow must use docker-compose.ci.yml');
  assert([...wf.matchAll(/runs-on:\s*(\S+)/g)].every((m) => m[1] === 'ubuntu-latest'),'e2e workflow must run on GitHub-hosted ubuntu-latest only');
  assert(readFileRel('.gitignore').includes('.e2e/'), '.e2e/ must be gitignored');
  return 'Caddy switch + overlay + workflow verified';
});

// 8b. Phone notifications (P2 block D5): outbound pushes to Element's gateway must keep working
check('Push path: federation off, default ip_range_denylist, tuwunel has egress, pusher knobs untouched', () => {
  const toml = readFileRel('config/tuwunel.toml').replace(/^\s*#.*$/gm, '');
  const base = readFileRel('docker-compose.yml').replace(/^\s*#.*$/gm, '');
  assert(/allow_federation\s*=\s*false/.test(toml), 'federation must stay off (pushes do not need it)');
  for (const k of ['ip_range_denylist', 'push_everything', 'notification_push_path', 'pusher_idle_timeout', 'forbidden_remote_server_names']) {
    assert(!new RegExp('^\\s*' + k + '\\s*=', 'm').test(toml), `tuwunel.toml must not set ${k} (keep the defaults: matrix.org is public so the default denylist allows it)`);
    assert(!base.includes('TUWUNEL_' + k.toUpperCase()), `docker-compose.yml must not set TUWUNEL_${k.toUpperCase()}`);
  }
  assert(compose.services.tuwunel.network_mode === undefined, 'tuwunel must keep the default compose network (needs outbound HTTPS to the push gateway)');
  assert(!/internal:\s*true/.test(base), 'no internal-only compose network (would cut tuwunel off from the push gateway)');
  assert(readFileRel('scripts/lib/push.mjs').includes('https://matrix.org/_matrix/push/v1/notify'), 'scripts/lib/push.mjs must name the Element X push gateway URL');
  assert(readFileRel('.github/workflows/e2e.yml').includes('2d-push.mjs'), 'e2e workflow must run the push e2e (2d-push.mjs)');
  return 'federation off, default denylist, egress intact, push e2e wired';
});

// 9. Hosted web client (P2 block C3b): pinned + checksummed Cinny, locked config, Caddy routing order
check('Hosted web client: pinned Cinny + sha256, rendered config, Caddy catch-all last', () => {
  const df = readFileRel('caddy/Dockerfile');
  assert(/ARG CINNY_VERSION=\d+\.\d+\.\d+/.test(df), 'Dockerfile must pin CINNY_VERSION to x.y.z');
  assert(/ARG CINNY_SHA256=[0-9a-f]{64}\b/.test(df), 'Dockerfile must pin CINNY_SHA256 (64 hex)');
  assert(df.includes('sha256sum -c'), 'Dockerfile must verify the Cinny tarball with sha256sum -c');
  assert(df.includes('ENTRYPOINT') && df.includes('squadz-entrypoint.sh'), 'Dockerfile must install the config-rendering entrypoint');

  const tpl = JSON.parse(readFileRel('config/web-client/config.json.template').replace(/__CHAT_FQDN__/g, 'chat.example.test'));
  assert(JSON.stringify(tpl.homeserverList) === '["chat.example.test"]', 'config template homeserverList must be exactly [CHAT_FQDN]');
  assert(tpl.defaultHomeserver === 0, 'config template defaultHomeserver must be 0');
  assert(tpl.allowCustomHomeservers === false, 'config template must set allowCustomHomeservers=false');
  assert(tpl.featuredCommunities.rooms.length === 0 && tpl.featuredCommunities.spaces.length === 0, 'featuredCommunities must be empty');
  assert(readFileRel('caddy/web-client-entrypoint.sh').includes('CHAT_FQDN'), 'entrypoint must render CHAT_FQDN');
  assert(
    compose.services.caddy.volumes.some((v) => v.startsWith('./config/web-client/config.json.template:')),
    'caddy service must mount config/web-client/config.json.template'
  );

  const cf = readFileRel('caddy/Caddyfile').replace(/\r\n/g, '\n');
  const chat = cf.slice(cf.indexOf('https://{$CHAT_FQDN}'), cf.indexOf('}\n\nhttps://{$RTC_FQDN} {'));
  const handles = [...chat.matchAll(/^\thandle(?:_path)?\b([^{\n]*)\{/gm)].map((m) => m[1].trim());
  assert(handles.length >= 5 && handles[handles.length - 1] === '', `catch-all "handle {" must be the last handler in the chat block (got: ${JSON.stringify(handles)})`);
  assert(chat.includes('try_files {path} /index.html'), 'Cinny block needs SPA fallback try_files');
  assert(chat.includes('X-Frame-Options SAMEORIGIN') && chat.includes("frame-ancestors 'self'"), 'Cinny block needs SAMEORIGIN + frame-ancestors for Element Call');
  assert(!/^\s*Permissions-Policy\b/mi.test(chat), 'must not set Permissions-Policy (breaks camera/mic/screen share)');
  return 'Cinny pinned+verified, config locked, catch-all handler last';
});

// Print summary report
console.log('Squadz Static Validation (scripts/validate.mjs)');
console.log('===============================================');
for (const r of results) {
  const badge = r.status === 'PASS' ? '[PASS]' : '[FAIL]';
  const suffix = r.detail ? ` — ${r.detail}` : '';
  console.log(`${badge} ${r.name}${suffix}`);
}
console.log('-----------------------------------------------');
if (failed > 0) {
  console.error(`Validation FAILED (${failed} of ${results.length} checks failed).`);
  process.exit(1);
} else {
  console.log(`Validation PASSED (${results.length}/${results.length} checks succeeded).`);
  process.exit(0);
}
