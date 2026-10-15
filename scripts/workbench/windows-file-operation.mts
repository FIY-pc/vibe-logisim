import { setTimeout } from "node:timers/promises";

/** Windows may hold newly executed binaries briefly after their process closes. */
export async function retryWindowsFileOperation<T>(
  operation: () => Promise<T>,
  platform: NodeJS.Platform = process.platform,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        platform !== "win32" ||
        attempt >= 10 ||
        !["EPERM", "EACCES", "EBUSY"].includes(
          (error as NodeJS.ErrnoException).code || "",
        )
      )
        throw error;
      // Bound the wait to 5.5 seconds; a persistent lock still fails the build.
      await setTimeout(100 * (attempt + 1));
    }
  }
}
