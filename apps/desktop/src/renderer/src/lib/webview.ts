/**
 * Electron `<webview>` yöntemleri öğe DOM'a bağlanıp `dom-ready` gelmeden çağrılınca fırlatır
 * ("The WebView must be attached to the DOM…"). HMR ile yeniden bağlanma ya da erken tıklama
 * bu duruma düşürür; bu sarmalayıcı hatayı yutar ve `undefined` döner.
 */
export function safeWebview<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
