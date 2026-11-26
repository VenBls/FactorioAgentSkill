import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { parseArgs } from 'node:util';

const authId = 1;
const commandId = 2;
const authRequest = 3;
const commandRequest = 2;
const authResponse = 2;
const commandResponse = 0;
const minimumPacketSize = 10;
const maximumReplySize = 64 * 1024;
const maximumCommandSize = 4096;

const help = `Usage: node factorio-rcon.mjs exec --command-file <path|-> [options]

Connects to the Factorio RCON service at 127.0.0.1 for one short command.
  --port N                RCON TCP port (default: 27015)
  --password-file PATH    Read the password from a UTF-8 file
                          (otherwise use FACTORIO_RCON_PASSWORD)
  --timeout-ms N          Total connection and reply timeout (default: 5000)
  --help                  Show this help

Use '-' to read the command from stdin. For Lua, call rcon.print once with
a short acknowledgement. After a timeout, check game state before retrying.`;

function makePacket(id, type, text) {
  const contents = Buffer.from(text, 'utf8');
  const packetSize = contents.length + minimumPacketSize;
  const packet = Buffer.alloc(packetSize + 4);
  packet.writeInt32LE(packetSize, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  contents.copy(packet, 12);
  return packet;
}

function readReply({ command, password, port, timeout }) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let buffered = Buffer.alloc(0);
    let authenticated = false;
    let finished = false;
    const deadline = setTimeout(() => fail(authenticated
      ? 'Timed out waiting for a reply after sending the command. Check the test map before retrying.'
      : 'Timed out connecting to or authenticating with Factorio RCON.'), timeout);

    function finish(error, reply) {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error);
      else resolve(reply);
    }

    function fail(message) {
      finish(new Error(message));
    }

    socket.setNoDelay(true);
    socket.on('connect', () => socket.write(makePacket(authId, authRequest, password)));
    socket.on('error', (error) => fail(`Factorio RCON connection failed${error.code ? ` (${error.code})` : ''}.`));
    socket.on('close', () => fail(authenticated
      ? 'Factorio closed RCON before replying. Check the test map before retrying.'
      : 'Factorio closed RCON before authenticating.'));
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4 && !finished) {
        const size = buffered.readInt32LE(0);
        if (size < minimumPacketSize || size > maximumReplySize) {
          fail('Invalid Factorio RCON packet size.');
          return;
        }
        const end = size + 4;
        if (buffered.length < end) return;
        const id = buffered.readInt32LE(4);
        const type = buffered.readInt32LE(8);
        const body = buffered.subarray(12, end - 2);
        if (buffered[end - 2] !== 0 || buffered[end - 1] !== 0 || body.includes(0)) {
          fail('Invalid Factorio RCON packet terminator.');
          return;
        }
        buffered = buffered.subarray(end);

        if (!authenticated) {
          if (id === authId && type === commandResponse && body.length === 0) continue;
          if (type === authResponse && id === -1) {
            fail('Factorio RCON authentication was rejected.');
            return;
          }
          if (type !== authResponse || id !== authId) {
            fail('Unexpected Factorio RCON authentication response.');
            return;
          }
          authenticated = true;
          socket.write(makePacket(commandId, commandRequest, command));
        } else if (id === commandId && type === commandResponse) {
          finish(undefined, body.toString('utf8'));
        } else {
          fail('Unexpected Factorio RCON command response. Inspect the test map before retrying.');
        }
      }
    });
  });
}

function integer(value, fallback, minimum, maximum, label) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

async function main() {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      'command-file': { type: 'string' },
      'password-file': { type: 'string' },
      'timeout-ms': { type: 'string' },
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (parsed.values.help) {
    console.log(help);
    return;
  }
  const commandFile = parsed.values['command-file'];
  const passwordFile = parsed.values['password-file'];
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== 'exec' || !commandFile) {
    throw new Error('Use exec --command-file <path|->. See --help.');
  }
  if (passwordFile === '-') throw new Error('A password file must be a path.');
  const port = integer(parsed.values.port, 27015, 1, 65535, '--port');
  const timeout = integer(parsed.values['timeout-ms'], 5000, 1, 120000, '--timeout-ms');
  const password = passwordFile
    ? readFileSync(passwordFile, 'utf8').replace(/^\uFEFF|\r?\n$/g, '')
    : process.env.FACTORIO_RCON_PASSWORD;
  if (!password || password.includes('\0') || Buffer.byteLength(password) > maximumCommandSize) {
    throw new Error('Set FACTORIO_RCON_PASSWORD or provide a valid --password-file.');
  }
  const command = readFileSync(commandFile === '-' ? 0 : commandFile, 'utf8').trim();
  if (!command || command.includes('\0') || Buffer.byteLength(command) > maximumCommandSize) {
    throw new Error('Provide a nonempty command of at most 4096 UTF-8 bytes.');
  }

  const reply = await readReply({ command, password, port, timeout });
  if (reply) process.stdout.write(reply.endsWith('\n') ? reply : `${reply}\n`);
}

main().catch((error) => {
  const message = error.code?.startsWith('ERR_PARSE_ARGS') ? 'Invalid arguments. See --help.' : error.message;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
