const PLUGIN_BRIDGE_CAPABILITIES: Record<string, readonly string[]> = {
  getSettings: ["settings:plugin"],
  updatePluginSettings: ["settings:plugin"],
  listPluginSecrets: ["secrets:plugin"],
  setPluginSecret: ["secrets:plugin"],
  deletePluginSecret: ["secrets:plugin"],
  listPluginDeliveries: ["deliveries:read"],
  getPluginDelivery: ["deliveries:read"],
  startTask: ["jobs:write"],
  listJobs: ["jobs:read"],
  readArticles: ["articles:read"],
  getArticleState: ["articles:read"],
  recordArticleAction: ["articles:write"],
  getArticleExplanation: ["articles:read", "ranking:read"],
  openArticle: ["articles:read"]
};

export function hasPluginBridgeCapability(
  capabilities: readonly string[],
  method: unknown
): boolean {
  if (typeof method !== "string") return false;
  return (PLUGIN_BRIDGE_CAPABILITIES[method] ?? []).every((capability) =>
    capabilities.includes(capability)
  );
}

export function assertPluginBridgeCapability(
  capabilities: readonly string[],
  method: unknown
): void {
  if (typeof method !== "string") return;
  const missing = (PLUGIN_BRIDGE_CAPABILITIES[method] ?? []).find(
    (capability) => !capabilities.includes(capability)
  );
  if (missing) {
    throw new Error(`Plugin capability required: ${missing}`);
  }
}
