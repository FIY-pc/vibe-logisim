export interface ReferenceRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type ReferenceInput =
  | {
      kind: "material";
      label: string;
      path: string;
      revision?: string;
      folderId?: string;
      pathVersion?: number;
      page?: number;
      region?: ReferenceRegion;
      text?: string;
      image?: string;
    }
  | { kind: "observation"; documentId: string; recordId: string };

export interface ReferenceSummary {
  id: string;
  kind: "material" | "observation";
  label: string;
  path?: string;
  revision?: string;
  folderId?: string;
  pathVersion?: number;
  page?: number;
  region?: ReferenceRegion;
  truncated?: boolean;
  hasImage: boolean;
}
export interface StoredReference extends ReferenceSummary {
  workspaceKey: string;
  text: string;
  image?: string;
}
