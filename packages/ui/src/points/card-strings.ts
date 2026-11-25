import type { PointsCardStrings } from "@psyche/protocol";
import { t } from "../i18n/core.ts";

/**
 * The helper's fixed card text in the owner's language, sent at Start (docs/design/psyche-points
 * -2026.md §8, §9). The helper ships no catalogue of its own. A message that takes a value keeps
 * the helper's `{label}`, `{app}`, `{n}` and `{total}` placeholders as they are, for the helper to
 * fill in; the Gateway cuts every string to 80 characters.
 */
// i18n-ignore: the helper's own placeholder, kept as written for the helper to fill in
const LABEL_SLOT = { label: "{label}" };

export function pointsCardStrings(): PointsCardStrings {
  return {
    back: t("points.card.back"),
    skip: t("points.card.skip"),
    next: t("points.card.next"),
    looksWrong: t("points.card.looksWrong"),
    stuck: t("points.card.stuck"),
    stuckMissing: t("points.card.stuckMissing"),
    stuckUnclear: t("points.card.stuckUnclear"),
    stuckBlocked: t("points.card.stuckBlocked"),
    askInPsyche: t("points.card.askInPsyche"),
    letLook: t("points.card.letLook"),
    stop: t("points.card.stop"),
    hideNote: t("points.card.hideNote"),
    copy: t("points.card.copy"),
    selfFill: t("points.card.selfFill", LABEL_SLOT),
    selfFillPlain: t("points.card.selfFillPlain"),
    payButton: t("points.card.payButton"),
    unknownValue: t("points.card.unknownValue"),
    scrollTo: t("points.card.scrollTo", LABEL_SLOT),
    menuBarTitle: t("points.card.menuBarTitle", { app: "{app}" }),
    stepFormat: t("points.card.stepFormat", { n: "{n}", total: "{total}" }),
    visionBadge: t("points.card.visionBadge"),
    followWindow: t("points.card.followWindow"),
  };
}
