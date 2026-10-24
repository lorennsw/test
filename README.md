# Pixel Shooter

Shooter pixel art para navegador: mazmorras procedurales, campaña, supervivencia, cooperativo online y Arena PvP (1v1, 2v2 y todos contra todos).

- `index.html` — el juego completo (se puede abrir directo en el navegador).
- `server.js` — servidor para Render: salas online, Arena PvP y cuentas.
- `store.js` — dónde se guardan las cuentas.

## Servidor (Render)

```
npm install
npm start
```

Variables de entorno opcionales:

| Variable | Para qué sirve |
| --- | --- |
| `DATABASE_URL` | URL de PostgreSQL (por ejemplo Render Postgres o neon.tech). **Sin esto las cuentas se guardan en un archivo que Render borra cada vez que reinicia el servidor.** |
| `TOKEN_SECRET` | Clave para firmar las sesiones. Si no está, se genera una y se guarda junto a las cuentas. |
| `PORT` | Puerto (Render lo pone solo). |

## Cuentas

- Registro e inicio de sesión desde la primera pantalla del juego (o "Jugar como invitado").
- Las contraseñas se guardan con scrypt; hay límite de intentos por IP.
- Con la sesión iniciada, las monedas, compras, equipo, récords y el personaje se guardan en la cuenta y aparecen en cualquier navegador.

## Arena PvP

- **1v1**: al mejor de 5 rondas.
- **2v2**: equipos al azar, sin fuego amigo; gana el primer equipo en llevarse 3 rondas.
- **Todos contra todos**: de 2 a 8 jugadores, reaparecés al morir; gana el primero en llegar a 10 bajas.
- Búsqueda automática de partida o sala privada. El mapa se sortea con una ruleta entre 6 mapas: Bosque, Mazmorra, Barco pirata, Cueva, Desierto y Glaciar.
- Rating Elo en 1v1 y 2v2 cuando todos los jugadores tienen cuenta. Ranking con los 10 mejores.
