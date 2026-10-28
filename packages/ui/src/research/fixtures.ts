import type { ResearchEvent } from "./model.ts";
import type { ReportView } from "./ResearchReport.tsx";

export const sampleEvents: ResearchEvent[] = [
  { type: "step", step: "plan" },
  {
    type: "plan",
    plan: {
      subQuestions: [
        { id: "q1", question: "How long do solar panels last?" },
        { id: "q2", question: "What does degradation look like year over year?" },
      ],
      includeLocal: false,
      estimatedTokens: 40_000,
    },
  },
  { type: "step", step: "read" },
  {
    type: "source",
    url: "https://energy.example/lifespan",
    title: "Panel lifespan",
    status: "read",
  },
  {
    type: "source",
    url: "https://lab.example/degradation",
    title: "Degradation study",
    status: "reading",
  },
  { type: "claims", count: 4 },
  { type: "tokens", used: 14_200, budget: 120_000 },
  { type: "step", step: "extract" },
];

export const sampleReport: ReportView = {
  title: "Solar panel lifespan",
  summary: "Panels typically last 25 to 30 years [1], losing about half a percent a year [2].",
  sections: [
    { heading: "Lifespan", body: "Manufacturers warrant 25 years [1, 2]." },
    { heading: "Degradation", body: "Output declines slowly [2]." },
  ],
  openQuestions: ["How do panels age in very hot climates?"],
  sources: [
    { n: 1, url: "https://energy.example/lifespan", title: "Panel lifespan", kind: "web" },
    { n: 2, url: "https://lab.example/degradation", title: "Degradation study", kind: "web" },
  ],
};
