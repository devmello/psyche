import type { InsightEntity } from "@psyche/protocol";
import { type KeyboardEvent, type ReactElement, useRef, useState } from "react";
import { ChartFigure } from "../components/charts/ChartFigure.tsx";
import { moveFocus } from "../components/charts/model.ts";
import { t } from "../i18n/core.ts";
import type { MessageId } from "../i18n/index.ts";
import { formatRelative } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { layoutPeopleMap, type NodeShape, type PeopleNode, type Ring } from "./peopleLayout.ts";

/** "Person" / "Organisation" / … for an entity kind. */
export const kindLabel = (kind: InsightEntity["kind"]): string =>
  t(`overview.people.kind.${kind}` as MessageId);

/** The plain-language facts of one entity: the node's accessible name and the detail line. */
export function entityFacts(
  entity: InsightEntity,
  now: number,
): { interactions: string; last: string; loops: string } {
  return {
    interactions: t("overview.people.interactions", { n: entity.interactions }),
    last: formatRelative(entity.lastInteractionAt, now),
    loops: t("overview.people.openLoops", { n: entity.openLoops }),
  };
}

export interface PeopleMapProps {
  entities: readonly InsightEntity[];
  /** Epoch ms for the recency rings. */
  now: number;
  /** Opens the entity (Soul & Memory's people section). */
  onOpen: (entityId: string) => void;
  /** Right-to-left layouts mirror the arrow keys. */
  rtl?: boolean;
}

/**
 * The People map (docs/design/agent-overview-2026.md §5.4): "you" in the centre and the top
 * entities on three recency rings, drawn from `layoutPeopleMap` so the same data always gives
 * the same picture. Edges join "you" to an entity and nothing else. Nodes are one tab stop with
 * arrow keys in rank order; hovering or focusing one fills the detail line under the map.
 */
export function PeopleMap({ entities, now, onOpen, rtl = false }: PeopleMapProps): ReactElement {
  const layout = layoutPeopleMap(entities, now);
  const { nodes } = layout;
  const [active, setActive] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const refs = useRef(new Map<number, SVGGElement>());
  const shown = hovered ?? focused;
  const node = shown === null ? undefined : nodes[shown];

  const onKeyDown = (from: number) => (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // A single ranked row: down/up are next/previous too.
    const forward = rtl ? "ArrowLeft" : "ArrowRight";
    const back = rtl ? "ArrowRight" : "ArrowLeft";
    const key = e.key === "ArrowDown" ? forward : e.key === "ArrowUp" ? back : e.key;
    const next = moveFocus(from, key, { count: nodes.length, rtl });
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    refs.current.get(next)?.focus();
  };

  const table = {
    head: [
      t("overview.people.table.name"),
      t("overview.people.table.kind"),
      t("overview.people.table.interactions"),
      t("overview.people.table.last"),
      t("overview.people.table.loops"),
    ],
    rows: nodes.map((n) => {
      const f = entityFacts(n.entity, now);
      return [n.entity.name, kindLabel(n.entity.kind), f.interactions, f.last, f.loops];
    }),
  };

  return (
    <ChartFigure
      label={t("overview.people.map")}
      table={table}
      hint={t("overview.people.mapHint")}
      testId="people-map"
      caption={
        <span className="flex flex-col gap-1">
          <span data-testid="people-map-detail" aria-hidden="true" className="min-h-5">
            {node === undefined ? (
              <span className="text-label-tertiary">{t("overview.people.detailHint")}</span>
            ) : (
              <Detail node={node} now={now} />
            )}
          </span>
          <span className="text-caption text-label-tertiary">{t("overview.people.caption")}</span>
        </span>
      }
    >
      {(hintId) => (
        // biome-ignore lint/a11y/useSemanticElements: an SVG group is not a fieldset
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          aria-label={t("overview.people.map")}
          aria-describedby={hintId}
          className="mx-auto block h-auto w-full max-w-[640px] select-none"
        >
          {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: a decorative group; the nodes are outside it */}
          <g aria-hidden="true">
            {layout.rings.map(({ ring, radius }) => (
              <g key={ring}>
                <circle
                  cx={layout.center.x}
                  cy={layout.center.y}
                  r={radius}
                  fill="none"
                  stroke="var(--separator)"
                  strokeDasharray="2 4"
                />
              </g>
            ))}
            {nodes.map((n) => (
              <line
                key={`edge-${n.entity.entityId}`}
                x1={layout.center.x}
                y1={layout.center.y}
                x2={n.x}
                y2={n.y}
                stroke="var(--separator)"
                strokeWidth={1}
              />
            ))}
            <g>
              <circle
                cx={layout.center.x}
                cy={layout.center.y}
                r={24}
                fill="var(--accent-9)"
                stroke="var(--surface-raised)"
                strokeWidth={2}
              />
              <text
                x={layout.center.x}
                y={layout.center.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={12}
                fontWeight={600}
                fill="var(--accent-contrast)"
              >
                {t("overview.people.you")}
              </text>
            </g>
          </g>
          {nodes.map((n, i) => (
            <Node
              key={n.entity.entityId}
              node={n}
              now={now}
              tabIndex={i === active ? 0 : -1}
              highlighted={shown === i}
              register={(el) => {
                if (el) refs.current.set(i, el);
                else refs.current.delete(i);
              }}
              onKeyDown={onKeyDown(i)}
              onOpen={() => onOpen(n.entity.entityId)}
              onHover={(on) => setHovered(on ? i : null)}
              onFocus={(on) => {
                setFocused(on ? i : null);
                if (on) setActive(i);
              }}
            />
          ))}
        </svg>
      )}
    </ChartFigure>
  );
}

function Detail({ node, now }: { node: PeopleNode; now: number }): ReactElement {
  const f = entityFacts(node.entity, now);
  return (
    <span className="text-label-primary">
      <span className="font-semibold">{node.entity.name}</span>
      <span className="text-label-secondary">
        {" "}
        · {kindLabel(node.entity.kind)} · {f.interactions} ·{" "}
        {t("overview.people.last", { when: f.last })}
        {node.entity.openLoops > 0 ? ` · ${f.loops}` : ""}
      </span>
    </span>
  );
}

const MAX_LABEL = 12;
const shortName = (name: string): string =>
  name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1)}…` : name;

function Mark({ shape, r }: { shape: NodeShape; r: number }): ReactElement {
  return shape === "circle" ? (
    <circle r={r} />
  ) : (
    <rect x={-r} y={-r} width={2 * r} height={2 * r} rx={r * 0.35} />
  );
}

function Node({
  node,
  now,
  tabIndex,
  highlighted,
  register,
  onKeyDown,
  onOpen,
  onHover,
  onFocus,
}: {
  node: PeopleNode;
  now: number;
  tabIndex: number;
  highlighted: boolean;
  register: (el: SVGGElement | null) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onOpen: () => void;
  onHover: (on: boolean) => void;
  onFocus: (on: boolean) => void;
}): ReactElement {
  const { entity } = node;
  const f = entityFacts(entity, now);
  const label = t("overview.people.node", {
    name: entity.name,
    kind: kindLabel(entity.kind),
    interactions: f.interactions,
    when: f.last,
    loops: f.loops,
  });
  const badge = node.radius * 0.75;
  return (
    // biome-ignore lint/a11y/useSemanticElements: an SVG node cannot be an anchor with a roving tabindex
    <g
      ref={register}
      role="link"
      tabIndex={tabIndex}
      aria-label={label}
      data-testid="people-node"
      data-rank={node.rank}
      data-ring={node.ring satisfies Ring}
      data-kind={entity.kind}
      transform={`translate(${node.x} ${node.y})`}
      className={cn("cursor-pointer outline-none", "[&:focus-visible_.ring]:opacity-100")}
      onClick={onOpen}
      onKeyDown={(e) => {
        onKeyDown(e);
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onFocus(true)}
      onBlur={() => onFocus(false)}
    >
      <g
        className="ring"
        opacity={highlighted ? 1 : 0}
        fill="none"
        stroke="var(--ring)"
        strokeWidth={2.5}
      >
        <Mark shape={node.shape} r={node.radius + 4} />
      </g>
      {/* An opaque underlay, so the edge to "you" never shows through the translucent fill. */}
      <g fill="var(--surface-raised)">
        <Mark shape={node.shape} r={node.radius} />
      </g>
      <g fill="var(--accent-a4)" stroke="var(--accent-9)" strokeWidth={2}>
        <Mark shape={node.shape} r={node.radius} />
      </g>
      <text y={node.radius + 13} textAnchor="middle" fontSize={11} fill="var(--label-secondary)">
        {shortName(entity.name)}
      </text>
      {entity.openLoops > 0 ? (
        <g
          transform={`translate(${node.radius * 0.8} ${-node.radius * 0.8})`}
          data-testid="people-node-loops"
        >
          <circle r={Math.max(7, badge)} fill="var(--label-primary)" />
          <text
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={9}
            fontWeight={700}
            fill="var(--surface-raised)"
          >
            {entity.openLoops}
          </text>
        </g>
      ) : null}
    </g>
  );
}
