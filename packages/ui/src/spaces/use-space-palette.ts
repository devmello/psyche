import { useStore } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import type { PaletteAction } from "../shell/CommandPalette.tsx";
import { spaceHref, useSpaces } from "./use-spaces.ts";

/**
 * ⌘K entries for Spaces (docs/design/spaces-2026.md §7.1): every Space by name, "New Space",
 * "Spaces", "Archived Spaces" and "New chat in <Space>". Loaded only while the palette is open.
 */
export function useSpacePaletteActions(
  open: boolean,
  onNavigate: (route: string) => void,
): PaletteAction[] {
  const store = useStore();
  const { spaces } = useSpaces({ enabled: open });
  const keywords = t("spaces.palette.keywords");
  const live = spaces.filter((s) => s.archivedAt == null);
  return [
    { id: "spaces", label: t("spaces.palette.spaces"), keywords, route: "/spaces" },
    { id: "spaces-new", label: t("spaces.palette.new"), keywords, route: "/spaces?new=1" },
    {
      id: "spaces-archived",
      label: t("spaces.palette.archived"),
      keywords,
      route: "/spaces#archived",
    },
    ...live.flatMap((s) => [
      { id: `space-${s.id}`, label: s.name, keywords, route: spaceHref(s.id) },
      {
        id: `space-chat-${s.id}`,
        label: t("spaces.palette.chatIn", { name: s.name }),
        keywords,
        run: () => {
          void store
            .call("threads.newChat", { kind: "side", spaceId: s.id })
            .then(({ thread }) => onNavigate(`/chat/${thread.id}`));
        },
      },
    ]),
  ];
}
