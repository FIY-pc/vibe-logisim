import { VirtuosoMockContext } from "react-virtuoso";
import { Theme } from "@radix-ui/themes";
import { createRoot as createReactRoot, type Root } from "react-dom/client";

/** Test roots provide the same theme and tooltip context as the application. */
export function createRoot(...args: Parameters<typeof createReactRoot>): Root {
  const root = createReactRoot(...args);
  return {
    render(children) {
      root.render(
        <VirtuosoMockContext.Provider
          value={{ viewportHeight: 10000, itemHeight: 100 }}
        >
          <Theme>{children}</Theme>
        </VirtuosoMockContext.Provider>,
      );
    },
    unmount() {
      root.unmount();
    },
  };
}
