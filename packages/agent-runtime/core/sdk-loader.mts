// Hosts may provide the SDK installed beside their own entry. The shared
// runtime keeps its normal bundled/development entry as the default.
let loader = () => import("./builtin-sdk.mts");
function setSdkLoader(next: () => Promise<typeof import("./builtin-sdk.mts")>) {
  if (typeof next !== "function")
    throw new TypeError("SDK loader must be a function");
  loader = next;
}
function loadSdk() {
  return loader();
}

export { loadSdk, setSdkLoader };
