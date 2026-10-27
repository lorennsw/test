package io.github.lorennswaggerboi.pixelshooter;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothServerSocket;
import android.bluetooth.BluetoothSocket;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.Closeable;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Partidas locales sin internet, por Wi-Fi local o Bluetooth.
 *
 * El celular anfitrión abre un servidor (TCP en Wi-Fi, RFCOMM en Bluetooth) y el juego (rooms.js)
 * hace de servidor de salas. Los demás se conectan a él. Los mensajes son las mismas líneas JSON
 * que usa el juego online, una por línea.
 *
 * El juego llama a estos métodos como window.PSNative; los avisos vuelven con window.psNet(evento):
 *   hosting {ip} · found {kind, addr, name|info} · conn {id} · msg {id, d} · close {id} · error {msg}
 * En el anfitrión, id es el jugador que se conectó; en el que se une, id es siempre 0 (el anfitrión).
 */
public class LocalNet {
    static final int TCP_PORT = 47820, UDP_PORT = 47821;
    static final UUID BT_UUID = UUID.fromString("6f5c2a7e-3b1d-4c8e-9a40-5f2c8d1e7b33");
    static final int BT_MAX_CLIENTS = 3;   // por Bluetooth, hasta 4 jugadores en total
    static final int REQ_PERMS = 7, REQ_DISCOVERABLE = 8;

    private final Activity act;
    private final WebView web;
    private final Map<Integer, Link> links = new ConcurrentHashMap<>();
    private final AtomicInteger nextId = new AtomicInteger(1);
    private volatile boolean hosting;
    private volatile String hostKind = "";
    private volatile String hostInfo = "{}";
    private ServerSocket tcpServer;
    private BluetoothServerSocket btServer;
    private DatagramSocket announcer, listener;
    private WifiManager.MulticastLock mlock;
    private BroadcastReceiver btReceiver;
    private Link client;
    private Runnable afterPerms;

    LocalNet(Activity act, WebView web) {
        this.act = act;
        this.web = web;
    }

    // ---------- avisos al juego
    private void emit(JSONObject o) {
        final String js = "window.psNet&&psNet(" + JSONObject.quote(o.toString()).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029") + ")";
        act.runOnUiThread(() -> web.evaluateJavascript(js, null));
    }
    private void emit(String e, Object... kv) {
        try {
            JSONObject o = new JSONObject().put("e", e);
            for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]);
            emit(o);
        } catch (Exception ignored) { }
    }
    private void error(String msg) { emit("error", "msg", msg); }

    // ---------- una conexión: lee líneas en un hilo y escribe líneas
    private class Link {
        final int id;
        final Closeable sock;
        final OutputStream out;
        final InputStream in;
        volatile boolean open = true;

        Link(int id, Closeable sock, InputStream in, OutputStream out) {
            this.id = id; this.sock = sock; this.in = in; this.out = out;
        }
        void start() {
            new Thread(() -> {
                try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
                    String line;
                    while (open && (line = r.readLine()) != null) emit("msg", "id", id, "d", line);
                } catch (Exception ignored) { }
                close(true);
            }, "ps-link-" + id).start();
        }
        synchronized void send(String text) {
            if (!open) return;
            try {
                out.write((text + "\n").getBytes(StandardCharsets.UTF_8));
                out.flush();
            } catch (Exception e) { close(true); }
        }
        void close(boolean notify) {
            if (!open) return;
            open = false;
            try { sock.close(); } catch (Exception ignored) { }
            if (id == 0) { if (client == this) client = null; }
            else links.remove(id);
            if (notify) emit("close", "id", id);
        }
    }

    private void addHostLink(Closeable sock, InputStream in, OutputStream out) {
        Link l = new Link(nextId.getAndIncrement(), sock, in, out);
        links.put(l.id, l);
        emit("conn", "id", l.id);
        l.start();
    }

    // ---------- API para el juego
    @JavascriptInterface
    public boolean available() { return true; }

    @JavascriptInterface
    public String localIp() { return wifiIp(); }

    /** Crea la partida: abre el servidor y la anuncia (Wi-Fi) o se hace visible (Bluetooth). */
    @JavascriptInterface
    public void host(String kind, String info) {
        stopHost();
        hostKind = kind;
        hostInfo = info == null ? "{}" : info;
        if ("bt".equals(kind)) withBtPerms(true, this::hostBt);
        else hostWifi();
    }

    @JavascriptInterface
    public void stopHost() {
        hosting = false;
        closeQuietly(tcpServer); tcpServer = null;
        closeQuietly(btServer); btServer = null;
        if (announcer != null) { announcer.close(); announcer = null; }
        for (Link l : new ArrayList<>(links.values())) l.close(false);
        links.clear();
    }

    /** Busca partidas: escucha anuncios en Wi-Fi o busca celulares por Bluetooth. */
    @JavascriptInterface
    public void scan(String kind) {
        stopScan();
        if ("bt".equals(kind)) withBtPerms(false, this::scanBt);
        else scanWifi();
    }

    @JavascriptInterface
    public void stopScan() {
        if (listener != null) { listener.close(); listener = null; }
        if (mlock != null) { try { mlock.release(); } catch (Exception ignored) { } mlock = null; }
        if (btReceiver != null) {
            try { act.unregisterReceiver(btReceiver); } catch (Exception ignored) { }
            btReceiver = null;
            BluetoothAdapter a = bt();
            if (a != null && hasBtPerms(false)) try { a.cancelDiscovery(); } catch (SecurityException ignored) { }
        }
    }

    /** Se une a la partida de addr (IP en Wi-Fi, dirección MAC en Bluetooth). */
    @JavascriptInterface
    public void connect(String kind, String addr) {
        disconnect();
        if ("bt".equals(kind)) withBtPerms(false, () -> connectBt(addr));
        else connectWifi(addr);
    }

    @JavascriptInterface
    public void disconnect() {
        Link c = client;
        if (c != null) c.close(false);
        client = null;
    }

    /** Manda una línea: el anfitrión a un jugador (id); el que se unió, al anfitrión (id 0). */
    @JavascriptInterface
    public void send(int id, String text) {
        Link l = id == 0 ? client : links.get(id);
        if (l != null) l.send(text);
    }

    void shutdown() {
        stopScan();
        stopHost();
        disconnect();
    }

    // ---------- Wi-Fi local
    private void hostWifi() {
        new Thread(() -> {
            try {
                tcpServer = new ServerSocket();
                tcpServer.setReuseAddress(true);
                tcpServer.bind(new InetSocketAddress(TCP_PORT));
            } catch (Exception e) {
                error("No se pudo abrir la partida en la red Wi-Fi");
                return;
            }
            hosting = true;
            final String ip = wifiIp();
            emit("hosting", "ip", ip);
            startAnnouncer();
            while (hosting) {
                try {
                    Socket s = tcpServer.accept();
                    s.setTcpNoDelay(true);
                    addHostLink(s, s.getInputStream(), s.getOutputStream());
                } catch (Exception e) {
                    break;
                }
            }
        }, "ps-wifi-host").start();
    }

    // anuncia la partida cada segundo por broadcast UDP, así aparece en la lista de los demás
    private void startAnnouncer() {
        new Thread(() -> {
            try {
                announcer = new DatagramSocket();
                announcer.setBroadcast(true);
                while (hosting && announcer != null) {
                    byte[] data = hostInfo.getBytes(StandardCharsets.UTF_8);
                    for (InetAddress dst : broadcastAddresses()) {
                        try { announcer.send(new DatagramPacket(data, data.length, dst, UDP_PORT)); } catch (Exception ignored) { }
                    }
                    Thread.sleep(1000);
                }
            } catch (Exception ignored) { }
        }, "ps-announce").start();
    }

    private void scanWifi() {
        try {
            WifiManager wm = (WifiManager) act.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) { mlock = wm.createMulticastLock("pixelshooter"); mlock.setReferenceCounted(false); mlock.acquire(); }
        } catch (Exception ignored) { }
        new Thread(() -> {
            try {
                DatagramSocket ds = new DatagramSocket(null);
                ds.setReuseAddress(true);
                ds.setBroadcast(true);
                ds.bind(new InetSocketAddress(UDP_PORT));
                listener = ds;
                byte[] buf = new byte[2048];
                while (listener == ds) {
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    ds.receive(p);
                    try {
                        JSONObject info = new JSONObject(new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8));
                        if (!"ps".equals(info.optString("g"))) continue;
                        emit("found", "kind", "wifi", "addr", p.getAddress().getHostAddress(), "info", info);
                    } catch (Exception ignored) { }
                }
            } catch (Exception e) {
                if (listener == null || !listener.isClosed()) error("No se pudo buscar partidas en la red Wi-Fi");
            }
        }, "ps-wifi-scan").start();
    }

    private void connectWifi(String ip) {
        new Thread(() -> {
            try {
                Socket s = new Socket();
                s.connect(new InetSocketAddress(ip, TCP_PORT), 6000);
                s.setTcpNoDelay(true);
                Link l = new Link(0, s, s.getInputStream(), s.getOutputStream());
                client = l;
                emit("conn", "id", 0);
                l.start();
            } catch (Exception e) {
                error("No se pudo conectar a " + ip + ". ¿Están en la misma red Wi-Fi?");
            }
        }, "ps-wifi-join").start();
    }

    private static List<InetAddress> broadcastAddresses() {
        List<InetAddress> out = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) if (ia.getBroadcast() != null) out.add(ia.getBroadcast());
            }
            out.add(InetAddress.getByName("255.255.255.255"));
        } catch (Exception ignored) { }
        return out;
    }

    // IP local para escribirla a mano (prefiere Wi-Fi / zona Wi-Fi: wlan, ap, swlan)
    private static String wifiIp() {
        String any = "";
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address)) continue;
                    String n = ni.getName();
                    if (n.startsWith("wlan") || n.startsWith("ap") || n.startsWith("swlan")) return a.getHostAddress();
                    if (any.isEmpty() && a.isSiteLocalAddress()) any = a.getHostAddress();
                }
            }
        } catch (Exception ignored) { }
        return any;
    }

    // ---------- Bluetooth
    private BluetoothAdapter bt() {
        BluetoothManager m = (BluetoothManager) act.getSystemService(Context.BLUETOOTH_SERVICE);
        return m == null ? null : m.getAdapter();
    }

    @SuppressLint("MissingPermission")   // los permisos ya se pidieron en withBtPerms
    private boolean btReady() {
        BluetoothAdapter a = bt();
        if (a == null) { error("Este celular no tiene Bluetooth"); return false; }
        if (!a.isEnabled()) {
            error("Activá el Bluetooth y probá de nuevo");
            try { act.startActivity(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)); } catch (Exception ignored) { }
            return false;
        }
        return true;
    }

    @SuppressLint("MissingPermission")
    private void hostBt() {
        if (!btReady()) return;
        try {
            btServer = bt().listenUsingInsecureRfcommWithServiceRecord("PixelShooter", BT_UUID);
        } catch (Exception e) {
            error("No se pudo abrir la partida por Bluetooth");
            return;
        }
        hosting = true;
        // que los demás puedan encontrar este celular durante 5 minutos
        act.runOnUiThread(() -> {
            try {
                Intent i = new Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE);
                i.putExtra(BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION, 300);
                act.startActivityForResult(i, REQ_DISCOVERABLE);
            } catch (Exception ignored) { }
        });
        emit("hosting", "ip", "");
        final BluetoothServerSocket server = btServer;
        new Thread(() -> {
            while (hosting && btServer == server) {
                try {
                    BluetoothSocket s = server.accept();
                    if (links.size() >= BT_MAX_CLIENTS) { s.close(); continue; }
                    addHostLink(s, s.getInputStream(), s.getOutputStream());
                } catch (Exception e) {
                    break;
                }
            }
        }, "ps-bt-host").start();
    }

    @SuppressLint("MissingPermission")
    private void scanBt() {
        if (!btReady()) return;
        BluetoothAdapter a = bt();
        // primero los celulares ya emparejados
        try {
            for (BluetoothDevice d : a.getBondedDevices()) emitBt(d);
        } catch (SecurityException ignored) { }
        btReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent i) {
                if (BluetoothDevice.ACTION_FOUND.equals(i.getAction())) {
                    BluetoothDevice d = i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                    if (d != null) emitBt(d);
                } else if (BluetoothAdapter.ACTION_DISCOVERY_FINISHED.equals(i.getAction()) && btReceiver == this) {
                    try { bt().startDiscovery(); } catch (SecurityException ignored) { }   // sigue buscando
                }
            }
        };
        IntentFilter f = new IntentFilter(BluetoothDevice.ACTION_FOUND);
        f.addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED);
        if (Build.VERSION.SDK_INT >= 33) act.registerReceiver(btReceiver, f, Context.RECEIVER_EXPORTED);
        else act.registerReceiver(btReceiver, f);
        try { a.startDiscovery(); } catch (SecurityException e) { error("Falta el permiso de Bluetooth"); }
    }

    @SuppressLint("MissingPermission")
    private void emitBt(BluetoothDevice d) {
        String name = null;
        try { name = d.getName(); } catch (SecurityException ignored) { }
        emit("found", "kind", "bt", "addr", d.getAddress(), "name", name == null ? d.getAddress() : name);
    }

    @SuppressLint("MissingPermission")
    private void connectBt(String mac) {
        if (!btReady()) return;
        new Thread(() -> {
            BluetoothAdapter a = bt();
            try { a.cancelDiscovery(); } catch (SecurityException ignored) { }
            BluetoothSocket s = null;
            try {
                BluetoothDevice d = a.getRemoteDevice(mac);
                s = d.createInsecureRfcommSocketToServiceRecord(BT_UUID);
                s.connect();
                Link l = new Link(0, s, s.getInputStream(), s.getOutputStream());
                client = l;
                emit("conn", "id", 0);
                l.start();
            } catch (Exception e) {
                closeQuietly(s);
                error("No se pudo conectar por Bluetooth. ¿Ese celular creó la partida?");
            }
        }, "ps-bt-join").start();
    }

    // ---------- permisos de Bluetooth (se piden la primera vez)
    private String[] btPerms(boolean host) {
        if (Build.VERSION.SDK_INT >= 31) {
            return host ? new String[]{Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_ADVERTISE}
                    : new String[]{Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN};
        }
        return new String[]{Manifest.permission.ACCESS_FINE_LOCATION};   // Android 11 o menos: para buscar dispositivos
    }

    private boolean hasBtPerms(boolean host) {
        for (String p : btPerms(host)) if (act.checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) return false;
        return true;
    }

    private void withBtPerms(boolean host, Runnable r) {
        if (hasBtPerms(host)) { r.run(); return; }
        afterPerms = r;
        act.runOnUiThread(() -> act.requestPermissions(btPerms(host), REQ_PERMS));
    }

    void onPermissionsResult(int code, int[] results) {
        if (code != REQ_PERMS) return;
        Runnable r = afterPerms;
        afterPerms = null;
        boolean ok = results.length > 0;
        for (int g : results) ok &= g == PackageManager.PERMISSION_GRANTED;
        if (ok && r != null) r.run();
        else if (!ok) error("Sin permiso de Bluetooth no se puede jugar por Bluetooth");
    }

    private static void closeQuietly(Closeable c) {
        if (c != null) try { c.close(); } catch (Exception ignored) { }
    }
}
