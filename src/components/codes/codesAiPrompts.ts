export type ContextualAiTask = "evidence" | "codes" | "note" | "codebook" | "themes";

export const BUILT_IN_CODES_AI_PROMPTS: Record<ContextualAiTask, string> = {
  evidence: "Identify analytically meaningful passages relevant to the research focus. Use exact quotations and briefly explain why each passage is relevant.",
  codes: "Prefer existing codes when their definitions and inclusion or exclusion criteria fit. Propose a new code only when no existing code is suitable.",
  note: "Draft one concise analytical paragraph grounded in the evidence and assigned codes. Use approximately 2–4 sentences and no more than 80 words. Clearly distinguish the participant's statement from the researcher's interpretation.",
  codebook: "Draft or refine a clear code definition with practical inclusion and exclusion criteria grounded in the research focus and supplied evidence.",
  themes: "Suggest or refine analytically coherent themes grounded in the supplied codes and their supporting evidence."
};

export function effectiveCodesAiPrompt(
  overrides: Partial<Record<ContextualAiTask, string>> | undefined,
  task: ContextualAiTask
) {
  return overrides?.[task]?.trim() || BUILT_IN_CODES_AI_PROMPTS[task];
}
