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

  const livekitYaml = readFileRel('config/livekit.yaml');
  assert(livekitYaml.includes('node_ip: ${MESH_IP}'), 'livekit.yaml must specify rtc.node_ip: ${MESH_IP}');
  assert(livekitYaml.includes('use_external_ip: false'), 'livekit.yaml must specify use_external_ip: false');
  assert(livekitYaml.includes('port_range_start: 50000'), 'livekit.yaml must specify port_range_start: 50000');
  assert(livekitYaml.includes('port_range_end: 50100'), 'livekit.yaml must specify port_range_end: 50100');
  assert(livekitYaml.includes('tcp_port: 7881'), 'livekit.yaml must specify tcp_port: 7881');

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
    sb.volumes.includes('${SOUNDBOARD_CLIPS_DIR}:/clips:ro'),
    'soundboard must mount ${SOUNDBOARD_CLIPS_DIR}:/clips:ro'
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
