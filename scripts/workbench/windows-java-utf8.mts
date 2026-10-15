import { NtExecutable, NtExecutableResource } from "resedit";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// OpenJDK 21's Windows launcher locates java.dll with GetModuleFileNameA/stat.
// A per-process UTF-8 codepage preserves non-ANSI installation paths on Windows
// 10 1903+ without changing the user's system locale or relying on 8.3 aliases.
export function utf8Launcher(bytes: Uint8Array): Buffer {
  const executable = NtExecutable.from(bytes, { ignoreCert: true });
  const resource = NtExecutableResource.from(executable);
  const manifests = resource.getResourceEntriesAsString(24, 1);
  if (!manifests.length)
    throw new Error("Java launcher has no application manifest");
  for (const [language, original] of manifests) {
    if (/activeCodePage/.test(original))
      throw new Error(
        "Java launcher already declares a codepage; review the upstream manifest",
      );
    const closing = /<\/(?:[\w.-]+:)?windowsSettings\s*>/;
    if (!closing.test(original))
      throw new Error("Unexpected Java launcher manifest");
    const manifest = original.replace(
      closing,
      (tag) =>
        '<activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>' +
        tag,
    );
    resource.replaceResourceEntryFromString(24, 1, language, manifest);
  }
  resource.outputResource(executable);
  // Rewriting invalidates the vendor Authenticode signature. pe-library removes
  // the certificate; never leave a misleading signature on our derived launcher.
  const result = Buffer.from(executable.generate());
  const decoded = NtExecutableResource.from(NtExecutable.from(result));
  if (
    decoded
      .getResourceEntriesAsString(24, 1)
      .some(([, text]) => !text.includes(">UTF-8</activeCodePage>"))
  )
    throw new Error("UTF-8 launcher manifest did not survive PE serialization");
  return result;
}

export async function patchWindowsJava(directory: string) {
  const bin = path.join(directory, "bin");
  const executables = (await readdir(bin)).filter((name) =>
    ["java.exe", "javac.exe"].includes(name),
  );
  if (!executables.includes("java.exe"))
    throw new Error("Java launcher is missing");
  for (const name of executables) {
    const file = path.join(bin, name);
    await writeFile(file, utf8Launcher(await readFile(file)));
  }
  await writeFile(
    path.join(directory, "VIBE-MODIFICATIONS.txt"),
    "This runtime is derived from the pinned Eclipse Temurin distribution.\n" +
      "Vibe Logisim adds activeCodePage=UTF-8 to launcher application manifests for Unicode installation paths on Windows 10 version 1903 or later.\n" +
      "Launcher executable certificates are removed because the manifest modification invalidates vendor Authenticode signatures. JVM code, modules and licenses are unchanged.\n",
  );
}
