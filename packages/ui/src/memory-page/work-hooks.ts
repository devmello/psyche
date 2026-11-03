import type { EntitySummary, GraphProjectType, GraphWorkStatus } from "@psyche/protocol";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useCall, useGatewayQuery } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";

/** Every assignment, open and done (the store keeps the done ones 14 days in Work due). */
export function useAssignments() {
  const found = useGatewayQuery("memory.entities.search", {
    q: "",
    kinds: ["assignment"],
    limit: 100,
  });
  const assignments: readonly EntitySummary[] = (found.data?.entities ?? []).filter(
    (e) => !e.isOwner && e.status === "active",
  );
  return { ...found, assignments };
}

/** Projects and courses (not the owner's own entity). */
export function useProjects() {
  const found = useGatewayQuery("memory.entities.search", {
    q: "",
    kinds: ["project"],
    limit: 100,
  });
  const projects: readonly EntitySummary[] = (found.data?.entities ?? []).filter(
    (e) => !e.isOwner && e.status === "active",
  );
  return { ...found, projects };
}

export interface NewAssignment {
  title: string;
  dueAt: string | null;
  parentId: string | null;
}

export interface NewProject {
  name: string;
  projectType: GraphProjectType;
}

function fail(err: unknown): void {
  toast.error(t("people.writeFailed", { reason: describeError(err) }));
}

/**
 * The owner's writes from the Work due and Projects tabs: Done, add an assignment (with its
 * `part_of` link), add a project or course. A failed write says so and changes nothing.
 */
export function useWorkWrites() {
  const call = useCall();
  const [busy, setBusy] = useState(false);

  const setStatus = useCallback(
    async (item: Pick<EntitySummary, "id">, status: GraphWorkStatus): Promise<boolean> => {
      setBusy(true);
      try {
        await call("memory.entities.facts.set", {
          entityId: item.id,
          attribute: "status",
          value: status,
          source: { kind: "owner_edit" },
        });
        return true;
      } catch (err) {
        fail(err);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [call],
  );

  const addAssignment = useCallback(
    async (input: NewAssignment): Promise<string | null> => {
      setBusy(true);
      try {
        const { entity } = await call("memory.entities.create", {
          kind: "assignment",
          name: input.title,
          ...(input.dueAt === null ? {} : { dueAt: input.dueAt }),
        });
        if (input.parentId !== null)
          await call("memory.entities.edges.set", {
            src: entity.id,
            rel: "part_of",
            dst: input.parentId,
            source: { kind: "owner_edit" },
          });
        return entity.id;
      } catch (err) {
        fail(err);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [call],
  );

  const addProject = useCallback(
    async (input: NewProject): Promise<string | null> => {
      setBusy(true);
      try {
        const { entity } = await call("memory.entities.create", {
          kind: "project",
          name: input.name,
          projectType: input.projectType,
          projectStatus: "active",
        });
        return entity.id;
      } catch (err) {
        fail(err);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [call],
  );

  return { busy, setStatus, addAssignment, addProject };
}
