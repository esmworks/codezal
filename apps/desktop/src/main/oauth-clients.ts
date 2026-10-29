/**
 * Codezal ile gelen OAuth istemcileri. Google dinamik istemci kaydı sunmadığından, yayıncının
 * doğrulanmış istemcisi uygulamaya gömülür ve kullanıcı yalnızca "Ekle" deyip tarayıcıda giriş
 * yapar (Claude'daki davranış). Değerler derleme sırasında `CODEZAL_GOOGLE_CLIENT_ID` ve
 * `CODEZAL_GOOGLE_CLIENT_SECRET` ortam değişkenlerinden gelir; verilmezse harita boş kalır ve
 * kullanıcı kendi istemcisini girer.
 */
declare const __GOOGLE_CLIENT_ID__: string;
declare const __GOOGLE_CLIENT_SECRET__: string;

export interface OauthClient {
  clientId: string;
  clientSecret: string;
}

/** Anahtar, katalogdaki `clientGroup` değeridir. */
export function builtInOauthClients(): Record<string, OauthClient> {
  // Geliştirmede ortam değişkeni, paketlenmiş uygulamada derlemede gömülen sabit kullanılır.
  const clientId = process.env.CODEZAL_GOOGLE_CLIENT_ID ?? __GOOGLE_CLIENT_ID__;
  const clientSecret = process.env.CODEZAL_GOOGLE_CLIENT_SECRET ?? __GOOGLE_CLIENT_SECRET__;
  return clientId && clientSecret ? { google: { clientId, clientSecret } } : {};
}
