import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** One model service the user configured: endpoint, protocol, credentials and the model it defaults to. */
export interface ServiceConfig {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  model: string;
  effort: Exclude<ThinkingLevel, "off"> | "none";
  contextWindow: number;
  vision: boolean;
  models?: string[];
}
/** A service as the UI sees it: the key replaced by a hint. */
export type PublicService = Omit<ServiceConfig, "apiKey"> & {
  apiKeyHint: string;
};
/** What a conversation remembers about the service it runs on; never a credential. */
export interface ServiceSelection extends Omit<
  ServiceConfig,
  "id" | "name" | "apiKey"
> {
  serviceId: string;
}
/** One row of the model picker. */
export interface ModelRow {
  model: string;
  name: string;
  description: string;
  isDefault: boolean;
  defaultEffort: string | null;
  efforts: { value: string; description: string }[];
}
