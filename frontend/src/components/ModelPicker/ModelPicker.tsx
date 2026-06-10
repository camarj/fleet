/**
 * ModelPicker — the shared provider + model selector used by the Deploy wizard
 * and the per-agent config modal. Owns its own provider/model/custom state and
 * reports every change up via `onChange`. The empty provider option means
 * "keep the source model (no override)".
 */

import { useState } from "react";
import { PROVIDER_CATALOG, modelsFor } from "../../lib/providers";

const CUSTOM = "__custom__";

interface Props {
  initialProvider?: string;
  initialModel?: string;
  /** Label for the empty-provider option (context-specific). */
  keepSourceLabel?: string;
  onChange: (next: { provider: string; model: string }) => void;
}

export function ModelPicker({
  initialProvider = "",
  initialModel = "",
  keepSourceLabel = "Keep source model (no change)",
  onChange,
}: Props): React.JSX.Element {
  const [provider, setProvider] = useState(initialProvider);
  const [model, setModel] = useState(initialModel);
  // Start in custom mode when the initial model isn't one of the curated ids.
  const [customModel, setCustomModel] = useState(
    initialProvider !== "" && !modelsFor(initialProvider).includes(initialModel),
  );

  function changeProvider(p: string): void {
    const models = p ? modelsFor(p) : [];
    // Providers with no curated models (e.g. OpenCode Go) start in Custom mode.
    const nextCustom = p !== "" && models.length === 0;
    const nextModel = models[0] ?? "";
    setProvider(p);
    setCustomModel(nextCustom);
    setModel(nextModel);
    onChange({ provider: p, model: nextModel });
  }

  function changeModel(value: string): void {
    if (value === CUSTOM) {
      setCustomModel(true);
      setModel("");
      onChange({ provider, model: "" });
    } else {
      setCustomModel(false);
      setModel(value);
      onChange({ provider, model: value });
    }
  }

  function changeCustomText(value: string): void {
    setModel(value);
    onChange({ provider, model: value });
  }

  return (
    <>
      <label>Provider</label>
      <select value={provider} onChange={(e) => changeProvider(e.target.value)}>
        <option value="">{keepSourceLabel}</option>
        {PROVIDER_CATALOG.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>

      {provider && (
        <>
          <label>Model</label>
          <select value={customModel ? CUSTOM : model} onChange={(e) => changeModel(e.target.value)}>
            {modelsFor(provider).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            <option value={CUSTOM}>Custom…</option>
          </select>
          {customModel && (
            <input
              value={model}
              onChange={(e) => changeCustomText(e.target.value)}
              placeholder="model id (e.g. gpt-5.5)"
              autoFocus
            />
          )}
        </>
      )}
    </>
  );
}
