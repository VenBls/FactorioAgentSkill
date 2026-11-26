import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { isIPv4 } from "node:net";

const [bind = "192.168.5.110", allowed = "192.168.5.139"] = process.argv.slice(2);
if (!isIPv4(bind) || !isIPv4(allowed) || bind === "0.0.0.0" || allowed === "0.0.0.0") {
  throw new Error("Specify the LAN interface address and authorized client IPv4 address.");
}
const port = 34197;
const headerSize = 6;
const maxPayload = 65507;
const expiryMs = 120_000;
const maxClients = 16;
const socket = createSocket("udp4");
const ports = new Map();
const clients = new Map();
let nextId = 1;
let peer;
let stopping = false;
let timer;
let retryMs = 2000;

const log = (message) => console.log(new Date().toISOString() + " " + message);
function connectPeer() {
  if (stopping) return;
  const child = spawn("docker.exe", ["exec", "-i", "factorio-codex-lab", "/usr/bin/perl", "/lab/config/lan-udp-peer.pl"], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  peer = { child, ready: false };
  let receive = Buffer.alloc(0);
  let diagnostic = "";
  const startupDeadline = setTimeout(() => {
    if (peer?.child === child && !peer.ready) child.kill();
  }, 8000);
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    diagnostic = (diagnostic + chunk).slice(-2048);
    if (peer?.child === child && !peer.ready && diagnostic.includes("Factorio UDP peer ready")) {
      peer.ready = true;
      clearTimeout(startupDeadline);
      retryMs = 2000;
      log("Container UDP peer ready.");
    }
  });
  child.stdin.on("error", (error) => {
    if (!stopping) log("Peer write error: " + error.message);
  });
  child.stdout.on("data", (chunk) => {
    if (peer?.child !== child) return;
    receive = receive.length ? Buffer.concat([receive, chunk]) : chunk;
    while (receive.length >= headerSize) {
      const id = receive.readUInt32BE(0);
      const size = receive.readUInt16BE(4);
      if (size > maxPayload) {
        log("Invalid frame from container UDP peer.");
        child.kill();
        return;
      }
      if (receive.length < headerSize + size) break;
      const payload = receive.subarray(headerSize, headerSize + size);
      receive = receive.subarray(headerSize + size);
      const client = clients.get(id);
      if (client) {
        client.activeAt = Date.now();
        socket.send(payload, client.port, allowed, (error) => {
          if (error && !stopping) log("LAN reply error: " + error.message);
        });
      }
    }
  });
  child.on("error", (error) => log("Could not start container UDP peer: " + error.message));
  child.on("close", (code) => {
    clearTimeout(startupDeadline);
    if (peer?.child === child) peer = undefined;
    clients.clear();
    ports.clear();
    if (stopping) return;
    log("Container UDP peer closed (" + code + "). " + diagnostic.trim());
    timer = setTimeout(connectPeer, retryMs);
    retryMs = Math.min(retryMs * 2, 30000);
  });
}

socket.on("message", (message, sender) => {
  if (sender.address !== allowed || !peer?.ready || message.length > maxPayload ||
      peer.child.stdin.destroyed || peer.child.stdin.writableLength > 1024 * 1024) return;
  let id = ports.get(sender.port);
  if (id === undefined) {
    if (clients.size >= maxClients) return;
    id = nextId++;
    clients.set(id, { port: sender.port, activeAt: 0 });
    ports.set(sender.port, id);
  }
  clients.get(id).activeAt = Date.now();
  const frame = Buffer.allocUnsafe(headerSize + message.length);
  frame.writeUInt32BE(id, 0);
  frame.writeUInt16BE(message.length, 4);
  message.copy(frame, headerSize);
  peer.child.stdin.write(frame);
});

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, client] of clients) {
    if (now - client.activeAt < expiryMs) continue;
    clients.delete(id);
    ports.delete(client.port);
  }
}, 10000);
cleanup.unref();

function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  peer?.child.stdin.end();
  peer?.child.kill();
  try { socket.close(); } catch {}
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
socket.on("error", (error) => { log(error.message); process.exitCode = 1; stop(); });
socket.bind(port, bind, () => {
  log("Factorio LAN UDP listening on " + bind + ":" + port + " for " + allowed + ".");
  connectPeer();
});
