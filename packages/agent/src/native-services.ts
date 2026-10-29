import type { NativeService, NativeServiceId } from "./native.js";
import { GCALENDAR_SERVICE } from "./native-gcalendar.js";
import { GDOCS_SERVICE } from "./native-gdocs.js";
import { GDRIVE_SERVICE } from "./native-gdrive.js";
import { GMAIL_SERVICE } from "./native-gmail.js";
import { GSHEETS_SERVICE } from "./native-gsheets.js";
import { GSLIDES_SERVICE } from "./native-gslides.js";

/** Uygulama içi servis kaydı; `McpManager` bağlayıcının `native.service` alanıyla buradan bulur. */
export const NATIVE_SERVICES: Record<NativeServiceId, NativeService> = {
  gdrive: GDRIVE_SERVICE,
  gmail: GMAIL_SERVICE,
  gcalendar: GCALENDAR_SERVICE,
  gdocs: GDOCS_SERVICE,
  gsheets: GSHEETS_SERVICE,
  gslides: GSLIDES_SERVICE,
};
