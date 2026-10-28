// Partidas locales sin internet por la red Wi-Fi / cable de la casa. Es la versión para PC de
// LocalNet.java de la app de Android y usa el mismo protocolo, así una PC y un celular pueden
// jugar juntos: el anfitrión abre un servidor TCP (47820) y se anuncia por broadcast UDP (47821);
// los mensajes son las líneas JSON del juego, una por línea.
//
// El juego la usa como window.PSNative y recibe los avisos con window.psNet(evento):
//   hosting {ip} · found {kind, addr, info} · conn {id} · msg {id, d} · close {id} · error {msg}
// En el anfitrión, id es el jugador que se conectó; en el que se une, id es siempre 0 (el anfitrión).
const net = require('net');
const dgram = require('dgram');
const os = require('os');

const TCP_PORT = 47820, UDP_PORT = 47821;

// IPv4 de la red local (prefiere Wi-Fi / Ethernet frente a adaptadores virtuales)
function localIp() {
  let any = '';
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/vEthernet|VirtualBox|VMware|WSL|Hyper-V|docker|vbox|Loopback/i.test(name)) { any = any || a.address; continue; }
      if (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(a.address)) return a.address;
      any = any || a.address;
    }
  }
  return any;
}

// direcciones de broadcast de cada red (más la general), para que el anuncio llegue a todos lados
function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number), m = a.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b & m[i]) | (~m[i] & 255)).join('.'));
    }
  }
  return [...out];
}

class LocalNet {
  constructor(emit) {
    this.emit = (e, o) => { try { emit(Object.assign({ e }, o)); } catch (err) { } };
    this.links = new Map();
    this.nextId = 1;
    this.server = null; this.announcer = null; this.announceTimer = null; this.listener = null; this.client = null;
    this.hostInfo = '{}';
  }

  // una conexión: separa las líneas que llegan y manda líneas
  link(id, sock) {
    const l = { id, sock, open: true, buf: '' };
    sock.setNoDelay(true);
    sock.setEncoding('utf8');
    sock.on('data', chunk => {
      l.buf += chunk;
      let i;
      while ((i = l.buf.indexOf('\n')) >= 0) {
        const line = l.buf.slice(0, i).replace(/\r$/, '');
        l.buf = l.buf.slice(i + 1);
        if (l.open) this.emit('msg', { id, d: line });
      }
    });
    const end = () => this.closeLink(l, true);
    sock.on('close', end);
    sock.on('error', end);
    return l;
  }
  closeLink(l, notify) {
    if (!l || !l.open) return;
    l.open = false;
    try { l.sock.destroy(); } catch (e) { }
    if (l.id === 0) { if (this.client === l) this.client = null; }
    else this.links.delete(l.id);
    if (notify) this.emit('close', { id: l.id });
  }

  // ---------- API para el juego (mismos nombres que en Android)
  available() { return true; }
  localIp() { return localIp(); }

  host(kind, info) {
    this.stopHost();
    this.hostInfo = info || '{}';
    const srv = net.createServer(sock => {
      const id = this.nextId++;
      const l = this.link(id, sock);
      this.links.set(id, l);
      this.emit('conn', { id });
    });
    srv.on('error', () => { if (this.server === srv) { this.stopHost(); this.emit('error', { msg: 'No se pudo abrir la partida en la red local. ¿Ya hay otra partida abierta en esta PC?' }); } });
    srv.listen(TCP_PORT, '0.0.0.0', () => {
      if (this.server !== srv) return;
      this.emit('hosting', { ip: localIp() });
      this.startAnnouncer();
    });
    this.server = srv;
  }

  startAnnouncer() {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', () => { });
    s.bind(() => {
      try { s.setBroadcast(true); } catch (e) { }
      const tick = () => {
        const data = Buffer.from(this.hostInfo, 'utf8');
        for (const dst of broadcastAddresses()) s.send(data, UDP_PORT, dst, () => { });
      };
      tick();
      this.announceTimer = setInterval(tick, 1000);
    });
    this.announcer = s;
  }

  stopHost() {
    clearInterval(this.announceTimer); this.announceTimer = null;
    if (this.announcer) { try { this.announcer.close(); } catch (e) { } this.announcer = null; }
    if (this.server) { try { this.server.close(); } catch (e) { } this.server = null; }
    for (const l of [...this.links.values()]) this.closeLink(l, false);
    this.links.clear();
  }

  scan(kind) {
    this.stopScan();
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('message', (buf, rinfo) => {
      try {
        const info = JSON.parse(buf.toString('utf8'));
        if (info && info.g === 'ps') this.emit('found', { kind: 'wifi', addr: rinfo.address, info });
      } catch (e) { }
    });
    s.on('error', () => { if (this.listener === s) { this.stopScan(); this.emit('error', { msg: 'No se pudo buscar partidas en la red local' }); } });
    s.bind(UDP_PORT, () => { try { s.setBroadcast(true); } catch (e) { } });
    this.listener = s;
  }

  stopScan() {
    if (this.listener) { try { this.listener.close(); } catch (e) { } this.listener = null; }
  }

  connect(kind, addr) {
    this.disconnect();
    const sock = net.connect({ host: String(addr || '').trim(), port: TCP_PORT });
    let ok = false;
    const fail = () => { if (!ok) { sock.destroy(); this.emit('error', { msg: `No se pudo conectar a ${addr}. ¿Están en la misma red?` }); } };
    sock.setTimeout(6000, () => { if (!ok) fail(); });
    sock.once('error', fail);
    sock.once('connect', () => {
      ok = true;
      sock.setTimeout(0);
      sock.removeListener('error', fail);
      this.client = this.link(0, sock);
      this.emit('conn', { id: 0 });
    });
  }

  disconnect() {
    if (this.client) this.closeLink(this.client, false);
    this.client = null;
  }

  send(id, text) {
    const l = id === 0 ? this.client : this.links.get(id);
    if (l && l.open) l.sock.write(text + '\n');
  }

  shutdown() { this.stopScan(); this.stopHost(); this.disconnect(); }
}

module.exports = { LocalNet };
