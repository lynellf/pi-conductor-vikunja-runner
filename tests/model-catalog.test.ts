import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

describe("embedded Pi model catalog", () => {
  it("recognizes the current OpenAI Codex and OpenRouter models used by conductor manifests", () => {
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());

    expect(registry.find("openai-codex", "gpt-5.6-terra")).toBeDefined();
    expect(registry.find("openai-codex", "gpt-5.6-luna")).toBeDefined();
    expect(registry.find("openrouter", "openai/gpt-5.6-terra")).toBeDefined();
    expect(registry.find("openrouter", "openai/gpt-5.6-luna")).toBeDefined();
  });
});
