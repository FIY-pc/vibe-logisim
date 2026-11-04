import { createContext, useContext, useState, type ReactNode } from "react";

type Disclosure = { phase: string; open: boolean };
const Expansion = createContext<{
  values: Map<string, Disclosure>;
  set: (key: string, value: Disclosure) => void;
} | null>(null);

/** A conversation owns disclosures, so recycling an offscreen turn does not
 * discard the reader's choices. A new turn phase still applies its defaults. */
export function TurnExpansionProvider({ children }: { children: ReactNode }) {
  const [values, setValues] = useState(() => new Map<string, Disclosure>());
  return (
    <Expansion.Provider
      value={{
        values,
        set: (key, value) => {
          setValues((old) => new Map(old).set(key, value));
        },
      }}
    >
      {children}
    </Expansion.Provider>
  );
}

export function useTurnDisclosure(
  key: string,
  phase: string,
  defaultOpen: boolean,
) {
  const shared = useContext(Expansion);
  const [local, setLocal] = useState<Disclosure>();
  const value = shared ? shared.values.get(key) : local;
  return [
    value?.phase === phase ? value.open : defaultOpen,
    (open: boolean) => {
      const next = { phase, open };
      if (shared) shared.set(key, next);
      else setLocal(next);
    },
  ] as const;
}
