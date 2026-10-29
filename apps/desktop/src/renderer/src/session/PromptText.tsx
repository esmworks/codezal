import type { CSSProperties } from "react";
import { clipParts, promptParts } from "../lib/promptText";
import { tokenIcon, tokenLabel } from "./editor/tokenNode";

/**
 * Kullanıcı mesajının metni: baştaki komut/beceri ve `@dosya` bahisleri yazma kutusundaki
 * etiketlerin aynısıyla çizilir (ZCode'un `ConversationUserInputContent`'i gibi), kalan metin
 * olduğu gibi. Metin önceden `collapsePrompt`'tan geçmiş olmalı: talimat blokları çözülmüştür.
 */
export function PromptText({
  text,
  upto,
  className = "",
}: {
  text: string;
  /** Katlanmış önizlemede gösterilen karakter sayısı; parçalar yine tam metinden çıkarılır. */
  upto?: number;
  className?: string;
}) {
  const parts = promptParts(text);
  return (
    <div className={className}>
      {(upto === undefined ? parts : clipParts(parts, upto)).map((part, i) => {
        // Parçalar metnin sırasıdır ve metin değişince hepsi yeniden kurulur; sıra anahtarı yeter.
        const key = `${i}-${part.kind}`;
        if (part.kind === "text") return <span key={key}>{part.text}</span>;
        const style = { "--cz-token-icon": tokenIcon(part.kind, part.value) } as CSSProperties;
        return (
          <span
            key={key}
            className="cz-token"
            data-token={part.kind}
            title={part.kind === "file" ? part.path : part.value}
            style={style}
          >
            {tokenLabel(part.kind, part.value)}
          </span>
        );
      })}
    </div>
  );
}
