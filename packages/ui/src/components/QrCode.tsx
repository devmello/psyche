import { type ReactElement, useMemo } from "react";
import { renderSVG } from "uqr";

/**
 * A QR code for `text`, drawn as inline SVG (no network, no image file). It is always black on
 * white with a quiet zone: scanners need the contrast, so it ignores the theme on purpose. Error
 * correction is `M`, which keeps a ~600-character pairing link at a size a phone reads easily.
 */
export function QrCode({
  text,
  label,
  className,
}: {
  text: string;
  /** What a screen reader says; the code itself is not readable by one. */
  label: string;
  className?: string;
}): ReactElement | null {
  const svg = useMemo(() => {
    try {
      return renderSVG(text, {
        ecc: "M",
        border: 2,
        whiteColor: "#ffffff",
        blackColor: "#000000",
      });
    } catch {
      return null; // too long for any QR version
    }
  }, [text]);
  if (svg === null) return null;
  return (
    <div
      role="img"
      aria-label={label}
      className={className}
      // The SVG is made by our own encoder from a string we hold: no markup from the Gateway.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: encoder output, not user HTML
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
