import type { UpstreamProviderCatalog } from "./upstream.js";

export type OpenAIModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
};

export type OpenAIModelList = {
  object: "list";
  data: OpenAIModel[];
};

const toStableCreatedTimestamp = (releaseDate: string) => {
  const parsed = Date.parse(releaseDate);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.floor(parsed / 1000);
};

const compareModelIds = (left: OpenAIModel, right: OpenAIModel) => {
  if (left.id < right.id) {
    return -1;
  }

  if (left.id > right.id) {
    return 1;
  }

  return 0;
};

export const mapProviderCatalogToOpenAIModelList = (catalog: UpstreamProviderCatalog): OpenAIModelList => ({
  object: "list",
  data: catalog.providers
    .filter((provider) => provider.connected && provider.models.length > 0)
    .flatMap((provider) =>
      provider.models.map((model) => ({
        id: `${provider.id}/${model.id}`,
        object: "model" as const,
        created: toStableCreatedTimestamp(model.releaseDate),
        owned_by: provider.id,
      })),
    )
    .sort(compareModelIds),
});
