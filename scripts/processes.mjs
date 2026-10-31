import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, sep, basename, join } from 'node:path';

const windows = process.platform === 'win32';
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

/** Run native tools without interpolating arguments into a command shell. */
export function start(command, args, options = {}) {
  if (!windows || !/^(npm|pnpm)$/.test(command)) {
    return spawn(command, args, { stdio: 'inherit', ...options });
  }
  // npm/pnpm ship .cmd launchers on Windows. PowerShell's call operator keeps
  // paths/arguments as data, including spaces and shell metacharacters.
  const request = Buffer.from(JSON.stringify({ command: `${command}.cmd`, args })).toString(
    'base64',
  );
  const script = `$ErrorActionPreference='Stop'; $r=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${request}')) | ConvertFrom-Json; $a=@($r.args); & $r.command @a; exit $LASTEXITCODE`;
  return spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { stdio: 'inherit', ...options },
  );
}

export function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status}): ${result.stderr.trim()}`);
  return result.stdout;
}

function powershell(script) {
  return capture('powershell.exe', [
    '-NoProfile',
    '-EncodedCommand',
    Buffer.from(`$ErrorActionPreference='Stop'; ${script}`, 'utf16le').toString('base64'),
  ]);
}

export function listProcesses() {
  if (windows) {
    const output = powershell(
      'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n="Started";e={if ($_.CreationDate) {$_.CreationDate.ToString("o")} else {""}}})',
    );
    return JSON.parse(output || '[]').map((item) => ({
      pid: item.ProcessId,
      parent: item.ParentProcessId,
      command: item.CommandLine || '',
      started: item.Started,
      executable: item.Name,
    }));
  }
  const executables = new Map(
    capture('ps', ['-axww', '-o', 'pid=,comm='])
      .trim()
      .split('\n')
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        return match ? [Number(match[1]), basename(match[2])] : [0, ''];
      }),
  );
  return capture('ps', ['-axww', '-o', 'pid=,ppid=,lstart=,args='])
    .trim()
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/);
      return (
        match && {
          pid: Number(match[1]),
          parent: Number(match[2]),
          started: match[3],
          command: match[4],
          executable: executables.get(Number(match[1])) || '',
        }
      );
    })
    .filter(Boolean);
}

export function listenerPids(ports) {
  if (!ports.length) return [];
  if (windows) {
    return JSON.parse(
      powershell(
        `ConvertTo-Json -Compress -InputObject @(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in @(${ports.join(',')}) } | Select-Object -ExpandProperty OwningProcess -Unique)`,
      ) || '[]',
    );
  }
  const pids = new Set();
  for (const port of ports) {
    const result = spawnSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    });
    if (result.error) throw new Error(`lsof is required to inspect ports: ${result.error.message}`);
    // lsof returns 1 when there are no matches. Other errors must not look free.
    if (result.status !== 0 && (result.status !== 1 || result.stderr.trim()))
      throw new Error(`Cannot inspect port ${port}: ${result.stderr.trim()}`);
    for (const value of result.stdout.trim().split(/\s+/).filter(Boolean)) pids.add(Number(value));
  }
  return [...pids];
}

export function descendants(pids, processes) {
  const result = new Set(pids);
  let changed;
  do {
    changed = false;
    for (const item of processes) {
      if (result.has(item.parent) && !result.has(item.pid)) {
        result.add(item.pid);
        changed = true;
      }
    }
  } while (changed);
  return [...result];
}

function protectedPids(processes) {
  const result = new Set([process.pid]);
  let current = process.pid;
  while (current) {
    current = processes.find((item) => item.pid === current)?.parent;
    if (current) result.add(current);
  }
  return result;
}

/** Keep relative npm launchers identifiable before they open a port on Windows. */
function readLease(root) {
  try {
    const value = JSON.parse(readFileSync(join(root, '.cache/lifecycle.json'), 'utf8'));
    if (value.version !== 1 || value.root !== resolve(root) || !Number.isInteger(value.pid))
      throw new Error('Invalid lifecycle lease. Inspect .cache/lifecycle.json before retrying.');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function acquireLease(root) {
  const processes = listProcesses();
  const current = processes.find((item) => item.pid === process.pid);
  if (!current?.started) throw new Error('Cannot identify the current process.');
  const previous = readLease(root);
  if (previous) {
    if (processes.some((item) => item.pid === previous.pid && item.started === previous.started))
      throw new Error(
        'A lifecycle operation is already running for this checkout. Use -f for dev/pro.',
      );
    unlinkSync(join(root, '.cache/lifecycle.json'));
  }
  mkdirSync(join(root, '.cache'), { recursive: true });
  const lease = { version: 1, root: resolve(root), pid: process.pid, started: current.started };
  const file = join(root, '.cache/lifecycle.json');
  writeFileSync(file, JSON.stringify(lease), { flag: 'wx', mode: 0o600 });
  return () => {
    const active = readLease(root);
    if (active?.pid === lease.pid && active.started === lease.started) unlinkSync(file);
  };
}

/** Find this checkout's runtimes, including workers without a listening port. */
export function ownedPids(root, processes = listProcesses()) {
  const excluded = protectedPids(processes);
  const directory = resolve(root);
  const normalized = windows ? directory.toLowerCase() : directory;
  const lease = readLease(directory);
  const found = processes
    .filter((item) => {
      if (
        excluded.has(item.pid) ||
        !/^(node|npm|pnpm|next|next-server.*|vite|dotnet|dart|dartaotruntime|flutter)(?:\.exe)?$/i.test(
          item.executable,
        )
      )
        return false;
      if (lease?.pid === item.pid && lease.started === item.started) return true;
      const command = windows ? item.command.toLowerCase().replaceAll('/', sep) : item.command;
      if (command.includes(`${normalized}${sep}`) || command.includes(`--prefix ${normalized}`))
        return true;
      if (windows) return false;
      const cwd = spawnSync('lsof', ['-a', '-p', String(item.pid), '-d', 'cwd', '-Fn'], {
        encoding: 'utf8',
      });
      const path = cwd.stdout
        ?.split('\n')
        .find((line) => line.startsWith('n'))
        ?.slice(1);
      return path === directory || path?.startsWith(`${directory}${sep}`);
    })
    .map((item) => item.pid);
  return descendants(found, processes).filter((pid) => !excluded.has(pid));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    if (!windows) return !capture('ps', ['-p', String(pid), '-o', 'stat=']).includes('Z');
    return true;
  } catch (error) {
    if (error.code === 'EPERM') throw error;
    return false;
  }
}

export async function stopPids(pids) {
  const excluded = protectedPids(listProcesses());
  if (pids.some((pid) => excluded.has(pid) || pid <= 1))
    throw new Error('Refusing to stop the current command or its parent processes.');
  if (!pids.length) return;
  console.log(`Stopping process tree: ${pids.join(', ')}`);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && pids.some(alive)) await delay(100);
  for (const pid of pids.filter(alive)) process.kill(pid, 'SIGKILL');
  const finalDeadline = Date.now() + 3000;
  while (Date.now() < finalDeadline && pids.some(alive)) await delay(100);
  if (pids.some(alive)) throw new Error('Some processes could not be stopped. Check permissions.');
}

/** Check the bind as well as the PID list, including inaccessible/reserved ports. */
export async function assertPortsFree(ports) {
  for (const port of ports) {
    for (const host of ['0.0.0.0', '::']) {
      await new Promise((done, reject) => {
        const server = createServer();
        server.once('error', (error) => {
          if (host === '::' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) done();
          else
            reject(
              new Error(
                `Port ${port} is unavailable (${error.code}). Use -f to free its owners, or correct the port/permissions.`,
              ),
            );
        });
        server.listen({ port, host, ipv6Only: host === '::' }, () => server.close(done));
      });
    }
  }
}

export async function prepare(root, ports, { force = false, stop = false } = {}) {
  const processes = listProcesses();
  const owned = ownedPids(root, processes);
  if (stop) {
    await stopPids(owned);
    return;
  }
  const listeners = listenerPids(ports);
  if (!force && (owned.length || listeners.length))
    throw new Error(
      `Process/port conflict (PIDs: ${[...new Set([...owned, ...listeners])].join(', ')}). Use -f to restart.`,
    );
  if (force) await stopPids(descendants([...new Set([...owned, ...listeners])], processes));
  await assertPortsFree(ports);
}
