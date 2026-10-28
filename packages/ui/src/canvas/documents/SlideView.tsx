import type { ArtifactDeckTheme, ArtifactSlide } from "@psyche/protocol";
import { Image as ImageIcon } from "lucide-react";
import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";

const THEME: Record<ArtifactDeckTheme, string> = {
  light: "bg-white text-neutral-900",
  dark: "bg-neutral-900 text-neutral-50",
  contrast: "bg-black text-yellow-200",
};

function Bullets({ items }: { items: readonly string[] | undefined }): ReactElement | null {
  if (items === undefined || items.length === 0) return null;
  return (
    <ul className="list-disc space-y-[0.5em] ps-[1.2em]">
      {items.map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: bullets are plain strings that can repeat
        <li key={i}>{b}</li>
      ))}
    </ul>
  );
}

/**
 * One slide at 16:9, sized by the container's font size (`cqw` units), so the same markup serves
 * the thumbnail, the editor preview and the presenter. Images are shown as a labelled frame: the
 * model's links are never fetched from here.
 */
export function SlideView({
  slide,
  theme,
  className,
}: {
  slide: ArtifactSlide;
  theme: ArtifactDeckTheme;
  className?: string;
}): ReactElement {
  const title = slide.title ?? "";
  return (
    <div
      className={cn(
        "@container aspect-video w-full overflow-hidden rounded-sm",
        THEME[theme],
        className,
      )}
      data-layout={slide.layout}
    >
      <div
        className={cn(
          "flex h-full flex-col gap-[3cqw] p-[5cqw]",
          slide.layout === "title" ? "items-center justify-center text-center" : "",
        )}
        style={{ fontSize: "2.4cqw" }}
      >
        {title !== "" ? (
          <h3
            className="font-semibold"
            style={{ fontSize: slide.layout === "title" ? "5.5cqw" : "4cqw" }}
          >
            {title}
          </h3>
        ) : null}
        {slide.layout === "two-column" ? (
          <div className="grid min-h-0 flex-1 grid-cols-2 gap-[4cqw]">
            <Bullets items={slide.bullets} />
            <Bullets items={slide.bullets2} />
          </div>
        ) : slide.layout === "title" ? (
          <p className="opacity-80" style={{ fontSize: "3cqw" }}>
            {slide.bullets?.[0]}
          </p>
        ) : (
          <>
            {slide.layout !== "blank" ? <Bullets items={slide.bullets} /> : null}
            {slide.image !== undefined && slide.layout !== "blank" ? (
              <div className="flex min-h-0 flex-1 items-center justify-center gap-2 rounded-sm border border-current/30 opacity-70">
                <ImageIcon className="size-[3cqw]" aria-hidden="true" />
                <span className="truncate">{t("deck.imageRef", { ref: slide.image })}</span>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
