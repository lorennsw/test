// Servidor del Pixel Shooter. Uso: npm i ws && node server.js
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 8080;
const MAX = 4;                                        // jugadores por sala
const DEFAULT_ROOMS = ['Sala 1', 'Sala 2', 'Sala 3']; // salas que siempre aparecen en la lista
const wss = new WebSocketServer({ port: PORT, maxPayload: 16 * 1024 });
const rooms = {};
let nextId = 1;
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const list = () => [...new Set([...DEFAULT_ROOMS, ...Object.keys(rooms)])]
  .map(n => [n, rooms[n] ? rooms[n].size : 0, MAX]);

wss.on('connection', ws => {
  ws.id = nextId++;
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'list') return send(ws, { t: 'rooms', l: list() });
    if (m.t === 'join') {
      if (ws.room) return;
      const name = String(m.room || 'D|Sala 1').slice(0, 30);
      const r = rooms[name] || new Set();
      if (r.size >= MAX) return send(ws, { t: 'full' });
      rooms[name] = r;
      ws.room = name;
      ws.host = r.size === 0;                         // el primero es el anfitrión (maneja los enemigos)
      r.add(ws);
      return send(ws, { t: 'welcome', id: ws.id, host: ws.host });
    }
    const r = rooms[ws.room];
    if (!r) return;
    m.from = ws.id;
    r.forEach(o => { if (m.to ? o.id === m.to : o !== ws) send(o, m); });
  });
  ws.on('close', () => {
    const r = rooms[ws.room];
    if (!r) return;
    r.delete(ws);
    r.forEach(o => send(o, { t: 'left', id: ws.id }));
    if (ws.host && r.size) { const n = [...r][0]; n.host = true; send(n, { t: 'host' }); } // pasa el anfitrión
    if (!r.size) delete rooms[ws.room];
  });
});
console.log('Servidor escuchando en el puerto', PORT);
