import { net, powerMonitor } from "electron";

/**
 * Ağ nöbetçisi: uykudan dönüşte ve çevrimdışı→çevrimiçi geçişinde bağlantıları tazeler.
 * Electron'un `online` olayı yok; 30 sn'lik yoklama `net.isOnline()` geçişini izler. Başlangıçta
 * bağlanma zaten `engine.mcp.start()` ile yapıldığından ilk değer yalnız referans alınır,
 * tetikleme yapılmaz — aksi hâlde her açılışta gereksiz bir tur koşardı.
 */

/** Çevrimdışı → çevrimiçi geçişi; test edilebilir saf işlev. */
export function isOnlineTransition(prev: boolean | undefined, next: boolean): boolean {
  return prev === false && next;
}

/** Nöbetçiyi başlatır; dönen işlev temizler (uygulama kapanışında çağrılır). */
export function startNetworkWatch(reconnect: () => void, intervalMs = 30_000): () => void {
  let last: boolean | undefined;
  // Uykudan dönüş her zaman denenir: bağlantı düşmüş olabilir, ağ hemen "online" görünmeyebilir.
  const onResume = () => reconnect();
  powerMonitor.on("resume", onResume);
  const timer = setInterval(() => {
    const online = net.isOnline();
    if (isOnlineTransition(last, online)) reconnect();
    last = online;
  }, intervalMs);
  // Nöbetçi uygulamayı ayakta tutmasın.
  timer.unref?.();
  last = net.isOnline();
  return () => {
    powerMonitor.removeListener("resume", onResume);
    clearInterval(timer);
  };
}
