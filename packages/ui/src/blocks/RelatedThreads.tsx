import { ChevronRight, MessagesSquare } from "lucide-react";
import { type ReactElement, useState } from "react";
import { formatDate } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { useSlots } from "../slots.tsx";
import type { BlockOf } from "./types.ts";

/**
 * "From your other chats" (E12): the owner's other chats this turn drew on, collapsed by default.
 * Titles and snippets are other chats' digests, untrusted data: plain text only, never Markdown,
 * with the untrusted border. Each item opens its chat.
 */
export function RelatedThreads({ block }: { block: BlockOf<"related_threads"> }): ReactElement {
  const [open, setOpen] = useState(false);
  const { navigate } = useSlots();
  const n = block.items.length;
  return (
    <div className="my-1 text-sm" data-testid="related-threads">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-gray-11 hover:bg-gray-3"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight
          className={cn("size-3.5 transition-transform duration-120", open && "rotate-90")}
          aria-hidden="true"
        />
        <MessagesSquare className="size-3.5" aria-hidden="true" />
        <span>
          From your other chats ({n} {n === 1 ? "chat" : "chats"})
        </span>
      </button>
      {open ? (
        <ul className="mt-1 ml-1 flex flex-col gap-1 border-l-2 border-untrusted pl-2">
          {block.items.map((item) => (
            <li key={item.threadId} className="flex flex-col">
              <button
                type="button"
                className="self-start text-left text-accent-11 hover:underline"
                onClick={() => navigate?.(`/chat/${item.threadId}`)}
              >
                {item.title || "Untitled chat"}
              </button>
              <span className="text-caption text-muted-foreground">
                {item.lastMessageAt ? `${formatDate(item.lastMessageAt)} · ` : ""}
                {item.snippet}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
