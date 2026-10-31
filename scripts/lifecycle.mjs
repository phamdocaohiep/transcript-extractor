import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import {
  prepare,
  start,
  listProcesses,
  descendants,
  stopPids,
  assertPortsFree,
  capture,
  acquireLease,
} from './processes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(new URL('./settings.json', import.meta.url), 'utf8'));
const [action, ...args] = process.argv.slice(2);
const publish = action?.startsWith('pub-');
const mode = action?.endsWith('pro') ? 'pro' : 'dev';
let force = false,
  stop = false,
  clean = false;
const forwarded = [];

function help() {
  console.log(
    `Usage: scripts/${action}.{sh,ps1} [-f|--force] [--stop] [--clean] [-h|--help]\n-f         Stop this checkout's process trees and ALL owners of its configured ports before starting.\n--stop     Stop this checkout's processes only; no build, install or port-owner cleanup.\n--clean    Remove generated build caches before building; preserves env, certificates and dependencies.\npub-*      Build/package locally; never upload or deploy.\n${config.kind === 'library' ? 'dev: Vite demo; pro: build then serve a separately built production demo.\n' : ''}${config.forward ? 'Vite options may follow --; --port/--strictPort overrides are rejected (set PORT instead).\n' : ''}`,
  );
}
if (!['dev', 'pro', 'pub-dev', 'pub-pro'].includes(action))
  throw new Error('Unknown lifecycle action.');
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (['-h', '--help'].includes(arg)) {
    help();
    process.exit(0);
  }
  if (['-f', '--force'].includes(arg)) force = true;
  else if (arg === '--stop') stop = true;
  else if (
    ['--clean', '-c', '--rebuild', '-r'].includes(arg) &&
    (arg === '--clean' || config.cleanAliases)
  )
    clean = true;
  else if (arg === '--' && config.forward && !publish) {
    forwarded.push(...args.slice(index + 1));
    break;
  } else throw new Error(`Unknown option: ${arg}. Use --help.`);
}
if (forwarded.some((arg) => /^--(?:port|strictPort)(?:=|$)/.test(arg)))
  throw new Error('Set PORT instead of overriding --port/--strictPort.');
if (stop && (force || clean || publish))
  throw new Error('--stop cannot be combined with -f, --clean or pub-*.');
if (publish && force) throw new Error('-f applies only to dev/pro.');
function port(value) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535)
    throw new Error(`Invalid port: ${value}`);
  return Number(value);
}
const publicPort = port(process.env.PORT || config.port);
const ports = [publicPort];
if (config.internal) ports.push(port(process.env.HTTPS_INTERNAL_PORT || publicPort + 10000));
if (new Set(ports).size !== ports.length) throw new Error('Public and internal ports must differ.');
process.chdir(root);
if (stop) {
  await prepare(root, ports, { stop: true });
  process.exit(0);
}
if (config.stubs !== undefined && mode === 'pro' && process.env.NEXT_PUBLIC_USE_STUBS === 'true')
  throw new Error('Production mode refuses NEXT_PUBLIC_USE_STUBS=true.');
if (!publish || clean) await prepare(root, publish ? [] : ports, { force });

const env = { ...process.env, PORT: String(publicPort), HOST: process.env.HOST || '0.0.0.0' };
if (config.internal) env.HTTPS_INTERNAL_PORT = String(ports[1]);
if (config.polling) env.WATCHPACK_POLLING ??= 'true';
if (config.ci) env.CI ??= 'true';
if (config.stubs !== undefined && mode === 'dev')
  env.NEXT_PUBLIC_USE_STUBS ??= String(publish ? true : config.stubs);
const releaseLease = acquireLease(root);
process.once('exit', releaseLease);
const manager = config.manager;
let active;
let tracked = new Map();
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (active?.pid) {
    const snapshot = listProcesses();
    const living = new Map(snapshot.map((item) => [item.pid, item.started]));
    const previous = [...tracked.keys()].filter((pid) => living.get(pid) === tracked.get(pid));
    await stopPids([...new Set([...previous, ...descendants([active.pid], snapshot)])]);
  }
  process.exit(signal === 'SIGINT' ? 130 : 143);
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    shutdown(signal).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  });
async function run(command, parameters, cwd = root) {
  if (shuttingDown) throw new Error('Startup was interrupted.');
  console.log(`> ${command} ${parameters.join(' ')}`);
  const child = start(command, parameters, { cwd, env });
  active = child;
  tracked = new Map();
  let trackingError;
  const timer = setInterval(() => {
    try {
      const snapshot = listProcesses();
      const selected = new Set(descendants([child.pid], snapshot));
      for (const item of snapshot) if (selected.has(item.pid)) tracked.set(item.pid, item.started);
    } catch (error) {
      trackingError = error;
      child.kill('SIGTERM');
    }
  }, 500);
  let status;
  try {
    status = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => done(code ?? (signal === 'SIGINT' ? 130 : 1)));
    });
  } finally {
    clearInterval(timer);
    // Capture children before an exited supervisor is reaped when possible.
    // Previous snapshots cover descendants already reparented by the OS.
    const snapshot = listProcesses();
    const living = new Map(snapshot.map((item) => [item.pid, item.started]));
    await stopPids(
      [...tracked.keys()].filter(
        (pid) => living.get(pid) === tracked.get(pid) && pid !== child.pid,
      ),
    );
    active = undefined;
    tracked.clear();
  }
  if (trackingError) throw trackingError;
  if (status !== 0) {
    const error = new Error(`${command} exited with status ${status}`);
    error.status = status;
    throw error;
  }
}
async function build() {
  await run(manager, config.target ? ['--filter', config.target, 'build'] : ['run', 'build']);
}
function cleanCaches() {
  // Fixed generated paths only: no dependency, lockfile, secret, certificate or source deletion.
  for (const path of config.caches) {
    const absolute = resolve(root, path);
    if (!absolute.startsWith(`${root}/`) && !absolute.startsWith(`${root}\\`))
      throw new Error('Cache path escapes checkout.');
    rmSync(absolute, { recursive: true, force: true });
  }
}
async function certificate() {
  const folder =
    env.ACADEMY_DEV_CERT_DIR ||
    env.HTTPS_CERT_DIR ||
    (config.certificate === 'local' ? join(root, 'certificates') : resolve(root, '../dev-certs'));
  env.ACADEMY_DEV_CERT_DIR = folder;
  env.HTTPS_CERT_FILE ||= join(folder, 'localhost.pem');
  env.HTTPS_KEY_FILE ||= join(folder, 'localhost-key.pem');
  if (process.platform !== 'win32') {
    await run('bash', [join(root, 'scripts/ensure-https-cert.sh')]);
    return;
  }
  await run('mkcert', ['-install']);
  const hosts = [
    'localhost',
    '127.0.0.1',
    '::1',
    '10.0.2.2',
    ...(env.ACADEMY_DEV_CERT_HOSTS || '').split(/\s+/).filter(Boolean),
  ];
  let valid = false;
  if (existsSync(env.HTTPS_CERT_FILE) && existsSync(env.HTTPS_KEY_FILE)) {
    try {
      const certificate = new X509Certificate(readFileSync(env.HTTPS_CERT_FILE));
      const { createPrivateKey } = await import('node:crypto');
      const ca = readFileSync(join(capture('mkcert', ['-CAROOT']).trim(), 'rootCA.pem'));
      valid =
        certificate.checkPrivateKey(createPrivateKey(readFileSync(env.HTTPS_KEY_FILE))) &&
        certificate.verify(new X509Certificate(ca).publicKey) &&
        Date.parse(certificate.validTo) > Date.now() + 30 * 86400000 &&
        hosts.every((host) =>
          /^[\d.:]+$/.test(host) ? certificate.checkIP(host) : certificate.checkHost(host),
        );
    } catch {
      valid = false;
    }
  }
  if (!valid) {
    mkdirSync(dirname(env.HTTPS_CERT_FILE), { recursive: true });
    mkdirSync(dirname(env.HTTPS_KEY_FILE), { recursive: true });
    await run('mkcert', [
      '-cert-file',
      env.HTTPS_CERT_FILE,
      '-key-file',
      env.HTTPS_KEY_FILE,
      ...hosts,
    ]);
  }
}
async function archive() {
  const output = join(root, 'publish');
  mkdirSync(output, { recursive: true });
  // An explicit source allowlist prevents .env, certificates and machine state from leaking.
  const excluded = [
    '.env',
    '.env.*',
    '*.pem',
    '*.key',
    'certificates',
    '.git',
    'node_modules',
    '.next/cache',
    '.next/dev',
    '.turbo',
    '.cache',
    'blob-report',
    'coverage',
    'test-results',
    'playwright-report',
    '*.log',
    '*.tsbuildinfo',
  ];
  const filename = join(
    output,
    `${config.name}-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`,
  );
  const entries = config.archive.filter((entry) => existsSync(join(root, entry)));
  await run('tar', [
    ...excluded.flatMap((entry) => ['--exclude', entry]),
    '-czf',
    filename,
    ...entries,
  ]);
  console.log(`Local artifact: ${filename}`);
}
async function execute() {
  if (clean) cleanCaches();
  await run(manager, manager === 'pnpm' ? ['install', '--frozen-lockfile'] : ['ci']);
  if (publish) {
    if (config.name === 'leonrichtext') {
      await run(process.execPath, ['scripts/check-licenses.mjs']);
      await build();
      await run('npm', ['pack']);
    } else if (config.name === 'pdfviewer')
      await run(process.execPath, ['scripts/pack-internal.mjs']);
    else if (config.kind === 'extension') {
      await run('npm', ['run', 'deploy']);
      await run(process.execPath, ['scripts/package-extension.js']);
    } else {
      await build();
      await archive();
    }
    return;
  }
  if (config.kind === 'next') {
    await certificate();
    await build();
    await assertPortsFree(ports);
    if (mode === 'pro') await run(process.execPath, ['scripts/start-production-https.mjs']);
    else if (config.internal) await run(process.execPath, ['scripts/start-development-https.mjs']);
    else
      await run(manager, [
        ...(config.target ? ['--filter', config.target] : []),
        'exec',
        'next',
        'dev',
        '-p',
        String(publicPort),
        '--hostname',
        env.HOST,
        '--experimental-https',
        '--experimental-https-key',
        env.HTTPS_KEY_FILE,
        '--experimental-https-cert',
        env.HTTPS_CERT_FILE,
      ]);
  } else {
    if (config.name === 'pdfviewer')
      await run(process.execPath, ['scripts/build-worker.mjs', '--demo']);
    if (mode === 'pro') {
      await build();
      if (config.kind === 'library') {
        // Library-mode Vite builds contain no HTML. Build the existing demo entry
        // separately; never replace the package's dist output with demo assets.
        await run(manager, [
          'exec',
          ...(manager === 'npm' ? ['--'] : []),
          'vite',
          'build',
          '--config',
          'scripts/demo.config.mjs',
        ]);
        await assertPortsFree(ports);
        await run(manager, [
          'exec',
          ...(manager === 'npm' ? ['--'] : []),
          'vite',
          'preview',
          '--config',
          'scripts/demo.config.mjs',
          '--port',
          String(publicPort),
          '--strictPort',
          '--host',
          env.HOST,
          ...forwarded,
        ]);
      } else {
        await assertPortsFree(ports);
        await run(manager, [
          'run',
          'preview',
          '--',
          '--port',
          String(publicPort),
          '--strictPort',
          '--host',
          env.HOST,
          ...forwarded,
        ]);
      }
    } else {
      await assertPortsFree(ports);
      await run(manager, [
        'run',
        'dev',
        '--',
        '--port',
        String(publicPort),
        '--strictPort',
        '--host',
        env.HOST,
        ...forwarded,
      ]);
    }
  }
}
try {
  await execute();
} catch (error) {
  console.error(error.message);
  process.exitCode = error.status || 1;
} finally {
  releaseLease();
}
