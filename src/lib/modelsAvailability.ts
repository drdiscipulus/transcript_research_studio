export type ModelAvailability = "missing" | "incomplete" | "ready";

export function modelAvailability(model: {
  installed: boolean;
  availability?: string;
}): ModelAvailability {
  if (model.availability === "ready" || model.availability === "incomplete" || model.availability === "missing") {
    return model.availability;
  }
  return model.installed ? "ready" : "missing";
}
