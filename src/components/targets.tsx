import { PLATFORM_FORMATS, type Platform } from "@/lib/schemas";
import { PLATFORM_LABEL } from "./ui";

/** Checkbox (multi) or select (single) list of platform/format combinations. */
export function TargetPicker({ platforms, name = "target", single = false, defaults = ["instagram/reel"] }: { platforms: Platform[]; name?: string; single?: boolean; defaults?: string[] }) {
  const options = platforms.flatMap((p) => PLATFORM_FORMATS[p].map((f) => ({ value: `${p}/${f}`, label: `${PLATFORM_LABEL[p]} · ${f}` })));
  if (single) {
    return (
      <select name={name} defaultValue={defaults[0]} required>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    );
  }
  return (
    <div className="row" role="group" aria-label="Platforms and formats">
      {options.map((o) => (
        <label key={o.value} className="inline">
          <input type="checkbox" name={name} value={o.value} defaultChecked={defaults.includes(o.value)} /> {o.label}
        </label>
      ))}
    </div>
  );
}
