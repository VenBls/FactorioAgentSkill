import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const client = fileURLToPath(new URL('./factorio-rcon.mjs', import.meta.url));
const defaultWorker = 'D:/Factorio-Lab/codex-worker/factorio-rcon.mjs';
const defaultPasswordFile = 'D:/Factorio-Lab/server/config/rcon-password';

export const connectionOptions = {
  ssh: { type: 'string' },
  'remote-worker': { type: 'string' },
  'password-file': { type: 'string' },
  port: { type: 'string', default: '27015' },
  'timeout-ms': { type: 'string', default: '45000' },
};

export function luaString(value) {
  return JSON.stringify(value).replace(/(?:\\\\|\\u00([a-f0-9]{2}))/gi, (match, code) =>
    code ? '\\' + Number.parseInt(code, 16).toString().padStart(3, '0') : match);
}

function numberInRange(value, minimum, maximum, label) {
  if (!/^\d+$/.test(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function powershellLiteral(value) {
  return "'" + value.replaceAll("'", "''") + "'";
}

export function createRconCaller(options) {
  const port = numberInRange(options.port, 1, 65535, '--port');
  const timeout = numberInRange(options['timeout-ms'], 1, 120000, '--timeout-ms');
  const passwordFile = options['password-file'] ?? (options.ssh ? defaultPasswordFile : undefined);
  const args = ['exec', '--command-file', '-', '--port', String(port), '--timeout-ms', String(timeout)];
  if (passwordFile) args.push('--password-file', passwordFile);

  let executable = process.execPath;
  let processArgs = [client, ...args];
  if (options.ssh) {
    if (!/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(options.ssh)) {
      throw new Error('--ssh must be a Windows SSH target written as user@host or host.');
    }
    const worker = options['remote-worker'] ?? defaultWorker;
    const command = '$ProgressPreference = "SilentlyContinue"; & node.exe '
      + [worker, ...args].map(powershellLiteral).join(' ') + '; exit $LASTEXITCODE';
    executable = 'ssh';
    processArgs = [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', options.ssh,
      'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64'),
    ];
  } else if (options['remote-worker']) {
    throw new Error('--remote-worker requires --ssh.');
  }

  return function call(commands) {
    const lua = '/sc local ok,v=pcall(function() ' + commands.split(/\r?\n/).map((line) => line.trim()).join(' ')
      + ' end); rcon.print(helpers.table_to_json({ok=ok,result=ok and v or nil,error=(not ok) and tostring(v) or nil}))';
    if (Buffer.byteLength(lua) > 4096) throw new Error('RCON Lua command exceeds 4096 UTF-8 bytes.');
    const result = spawnSync(executable, processArgs, {
      input: lua,
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeout + 15000,
      maxBuffer: 128 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr.trim() || 'RCON child failed.');
    let reply;
    try {
      reply = JSON.parse(result.stdout.trim());
    } catch {
      throw new Error('The server did not return a complete JSON acknowledgement.');
    }
    if (!reply.ok) throw new Error(reply.error || 'The server rejected the request.');
    return reply.result;
  };
}
