import { RotateCw, X } from "lucide-react";
import { Checkbox } from "../shared/Checkbox";
import { IconButton } from "../shared/IconButton";
import { canRotate, type PlacementState } from "./usePlacement";
import { useEditor, useSettings } from "../app/hooks";

/** Rotation, repetition and cancelling of the component being placed. */
export function PlacementControls({
  placement,
}: {
  placement: PlacementState;
}) {
  const place = useEditor((state) => state.place);
  const setPlace = useEditor((state) => state.setPlace);
  const shortcuts = useSettings((state) => state.labels);
  if (!place) return null;
  return (
    <>
      <IconButton
        title="旋转 90°"
        shortcut={shortcuts.rotate}
        icon={<RotateCw size={14} />}
        onClick={() => placement.rotate()}
        disabled={!canRotate(placement)}
      />
      <label className="placement-repeat">
        <Checkbox
          checked={placement.repeat}
          onCheckedChange={placement.setRepeat}
        />
        连续放置
      </label>
      <button className="placing" onClick={() => setPlace(null)}>
        {place.label}
        <X size={12} />
      </button>
    </>
  );
}
