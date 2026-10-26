import type { Block, Message, ToolCall } from "@psyche/protocol";
import { Shapes } from "lucide-react";
import type { ComponentType, ReactElement } from "react";
import { t } from "../i18n/core.ts";
import { Card } from "./card.tsx";
import type { BlockOf } from "./types.ts";

/**
 * The block registry (docs/design/chat-experience-2026.md §4.1): one renderer per block type,
 * in place of a hard-coded switch. Adding a block is a protocol schema plus one
 * `registerBlock` call; an unregistered type renders a quiet fallback card, never nothing.
 */

/** What every block view gets besides its block. */
export interface BlockContext {
  message: Message;
  /** Pin the checklist (only under the latest agent message). */
  pinChecklist: boolean;
  /** Sends a wrap-up button's message. */
  onWrapUpAction?: ((message: string) => void) | undefined;
  /** The message came from an untrusted source (marker on prose). */
  untrusted: boolean;
}

export interface BlockViewProps<T extends Block["type"]> {
  block: BlockOf<T>;
  ctx: BlockContext;
}

export interface BlockRenderer<T extends Block["type"] = Block["type"]> {
  /** Returns null when the block is drawn elsewhere (compaction notices, folded tool runs). */
  View: ComponentType<BlockViewProps<T>>;
  /** Sample blocks for stories and tests. */
  fixtures?: readonly BlockOf<T>[];
}

const blocks = new Map<string, BlockRenderer<never>>();

/** Registers the renderer for a block type; returns a function that removes it again. */
export function registerBlock<T extends Block["type"]>(
  type: T,
  renderer: BlockRenderer<T>,
): () => void {
  const previous = blocks.get(type);
  blocks.set(type, renderer as unknown as BlockRenderer<never>);
  return () => {
    if (previous) blocks.set(type, previous);
    else blocks.delete(type);
  };
}

export function blockRenderer<T extends Block["type"]>(type: T): BlockRenderer<T> | undefined {
  return blocks.get(type) as BlockRenderer<T> | undefined;
}

export function registeredBlockTypes(): readonly string[] {
  return [...blocks.keys()];
}

/** A block type this build doesn't know (a newer Gateway): a quiet card, not a gap. */
export function UnknownBlock({ type }: { type: string }): ReactElement {
  return (
    <Card
      variant="inline"
      label={t("blocks.card.unknown", { type })}
      icon={<Shapes />}
      title={t("blocks.card.unknown", { type })}
      data-testid="unknown-block"
    />
  );
}

/** Renders one block through the registry. */
export function RegisteredBlock({ block, ctx }: { block: Block; ctx: BlockContext }): ReactElement {
  const renderer = blockRenderer(block.type);
  if (!renderer) return <UnknownBlock type={block.type} />;
  const View = renderer.View as ComponentType<BlockViewProps<Block["type"]>>;
  return <View block={block as BlockOf<Block["type"]>} ctx={ctx} />;
}

/**
 * The tool-result → component map (§4.1, assistant-ui style): a view per tool name, or per
 * `resultKind` when several tools share a result shape. The view gets the call and, once
 * loaded, the stored result behind `resultRef`; it renders a compact inline preview.
 */
export interface ToolViewProps {
  call: ToolCall;
  result?: unknown;
}

const toolViews = new Map<string, ComponentType<ToolViewProps>>();

/** Registers a view for a tool name (`calendar.list`) or a result kind (`kind:mail`). */
export function registerToolView(key: string, View: ComponentType<ToolViewProps>): () => void {
  const previous = toolViews.get(key);
  toolViews.set(key, View);
  return () => {
    if (previous) toolViews.set(key, previous);
    else toolViews.delete(key);
  };
}

/**
 * The view for a call: its exact tool name first, then the name without a connector prefix
 * (`mcp__apple__calendar_list_events` → `calendar_list_events`), then its result kind.
 */
export function toolViewFor(
  tool: string,
  resultKind?: string | null,
): ComponentType<ToolViewProps> | undefined {
  const bare = /^mcp__.+?__(.+)$/.exec(tool)?.[1];
  return (
    toolViews.get(tool) ??
    (bare === undefined ? undefined : toolViews.get(bare)) ??
    (resultKind ? toolViews.get(`kind:${resultKind}`) : undefined)
  );
}
