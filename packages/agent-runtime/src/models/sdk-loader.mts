// The pi SDK entry, loaded on first use so the sidecar starts before the SDK is needed.
export const loadSdk = () => import("./sdk.mts");
