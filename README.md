# Pixel Shooter

Shooter pixel art para navegador: mazmorras procedurales, campaña, supervivencia, cooperativo online y Arena PvP (1v1, 2v2 y todos contra todos).

- `index.html` — el juego completo (se puede abrir directo en el navegador).
- `server.js` — servidor para Render: salas online, Arena PvP y cuentas.
- `store.js` — dónde se guardan las cuentas.
- `rooms.js` — motor de salas (cooperativo y PvP), compartido por el servidor y las partidas locales de la app.

## App de Android (APK)

- Descarga directa de la última versión: https://github.com/lorennswaggerboi-lab/test/releases/latest/download/PixelShooter.apk
- GitHub Actions (`.github/workflows/apk.yml`) la compila y publica sola cada vez que cambia el juego en `main`.
- La app trae el juego adentro (`index.html` + `fonts/`): los modos sin conexión se juegan sin internet y el online usa el mismo servidor.
- Código en `android/`: una WebView a pantalla completa y horizontal, con el botón "atrás" para pausar o volver.
- Compilar a mano: `cd android && ./gradlew assembleRelease` (necesita JDK 17+ y el SDK de Android).
- **Partida local sin internet** (solo en la app): por Wi-Fi local (misma red o zona Wi-Fi) o por Bluetooth (hasta 8 jugadores). Un celular crea la partida y corre el motor de salas (`rooms.js`, el mismo del servidor); los demás se unen desde una lista. Sirve para el cooperativo y para el PvP privado (sin cambiar el rating). La parte de Android está en `android/.../LocalNet.java`.
- Está firmada con `android/pixelshooter.keystore` (clave de juego casero, incluida en el repo) para que cada versión nueva se instale encima de la anterior.

## Juego para PC (Windows)

- Instalador: https://github.com/lorennswaggerboi-lab/test/releases/latest/download/PixelShooter-Setup.exe (lo publica el mismo workflow, en la misma release que la APK).
- Instalador en español con bienvenida, términos, elección de carpeta, accesos directos en el escritorio y el menú Inicio, y desinstalador en "Agregar o quitar programas". La partida guardada no se borra al desinstalar.
- El juego de PC **se actualiza solo**: baja la versión nueva en segundo plano (`latest.yml` de la última release) y la instala al cerrar.
- Código en `desktop/`: Electron con el juego adentro (`npm run game` copia `index.html`, `rooms.js` y `fonts/`). `F11` o `Alt+Enter` para pantalla completa; recuerda el tamaño de la ventana.
- **Partida local** por la red de la casa (Wi-Fi o cable), con el mismo protocolo que la app de Android (`desktop/localnet.js`), así una PC y un celular pueden jugar juntos.
- Compilar a mano: `cd desktop && npm install && npm run dist` (en Linux necesita Wine). Las imágenes del instalador se generan con `desktop/scripts/make-art.py`.
- El instalador no está firmado con un certificado: Windows puede mostrar "Windows protegió tu PC" → *Más información* → *Ejecutar de todas formas*.

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

### Guardar las cuentas para siempre (PostgreSQL gratis con Neon)

Sin base de datos, Render gratis borra las cuentas y el ranking cada vez que reinicia el servidor.

1. Entrá a [neon.tech](https://neon.tech), creá una cuenta (sirve la de GitHub) y un proyecto nuevo.
2. Copiá la *connection string*. Empieza con `postgresql://` y termina en `neon.tech/neondb?sslmode=require`.
3. En Render abrí el servicio → **Environment** → **Add Environment Variable**: nombre `DATABASE_URL`, valor la URL que copiaste → **Save, rebuild and deploy**.
4. Abrí `https://TU-SERVICIO.onrender.com/api/info`: tiene que decir `"storage":"PostgreSQL","persistent":true`.

Las tablas se crean solas la primera vez.

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
