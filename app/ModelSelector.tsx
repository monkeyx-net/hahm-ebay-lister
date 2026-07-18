"use client";

import { useEffect, useState } from "react";
import {
  getAnalysisModel,
  getSortModel,
  saveAnalysisModel,
  saveSortModel,
  type ModelChoice,
} from "@/lib/model-preferences";
import type { ModelOption, ModelsPayload } from "@/lib/types";

// <select> values must be flat strings — encode/decode {provider, model} as
// "provider::model" (see lib/model-preferences.ts for why "::" is safe).
function encode(choice: ModelChoice): string {
  return `${choice.provider}::${choice.model}`;
}
function decode(value: string): ModelChoice | null {
  const sep = value.indexOf("::");
  if (sep === -1) return null;
  const provider = value.slice(0, sep);
  const model = value.slice(sep + 2);
  if ((provider !== "anthropic" && provider !== "openrouter" && provider !== "omniroute") || !model) {
    return null;
  }
  return { provider, model };
}
function sameChoice(a: ModelChoice | null, b: ModelOption | undefined): boolean {
  return !!a && !!b && a.provider === b.provider && a.model === b.id;
}

function OptGroup({ label, options }: { label: string; options: ModelOption[] }) {
  if (options.length === 0) return null;
  return (
    <optgroup label={label}>
      {options.map((m) => (
        <option key={encode({ provider: m.provider, model: m.id })} value={encode({ provider: m.provider, model: m.id })}>
          {m.displayName}
          {m.isDefault ? " (default)" : ""}
        </option>
      ))}
    </optgroup>
  );
}

function ModelOptions({ options }: { options: ModelOption[] }) {
  return (
    <>
      <OptGroup label="Claude" options={options.filter((m) => m.provider === "anthropic")} />
      <OptGroup label="OpenRouter (free)" options={options.filter((m) => m.provider === "openrouter")} />
      <OptGroup label="OmniRoute (self-hosted)" options={options.filter((m) => m.provider === "omniroute")} />
    </>
  );
}

export function ModelSelector() {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelsPayload | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [sortModel, setSortModel] = useState<ModelChoice | null>(null);
  const [analysisModel, setAnalysisModel] = useState<ModelChoice | null>(null);

  useEffect(() => {
    const savedSort = getSortModel();
    const savedAnalysis = getAnalysisModel();

    fetch("/api/models")
      .then((r) => r.json())
      .then((data: ModelsPayload) => {
        setModels(data);

        // Persist the resolved default to localStorage when there's no valid
        // saved choice, so page.tsx (which reads the request's {provider, model}
        // straight from localStorage) sends this default instead of nothing —
        // otherwise the server would fall back to its own default provider, which
        // may not match what the picker shows.
        const defaultSort =
          data.sortModels.find((m) => m.isDefault) ?? data.sortModels[0];
        const resolvedSort =
          savedSort && data.sortModels.some((m) => sameChoice(savedSort, m))
            ? savedSort
            : defaultSort
              ? { provider: defaultSort.provider, model: defaultSort.id }
              : null;
        if (resolvedSort && resolvedSort !== savedSort) saveSortModel(resolvedSort);
        setSortModel(resolvedSort);

        const defaultAnalysis =
          data.analysisModels.find((m) => m.isDefault) ?? data.analysisModels[0];
        const resolvedAnalysis =
          savedAnalysis && data.analysisModels.some((m) => sameChoice(savedAnalysis, m))
            ? savedAnalysis
            : defaultAnalysis
              ? { provider: defaultAnalysis.provider, model: defaultAnalysis.id }
              : null;
        if (resolvedAnalysis && resolvedAnalysis !== savedAnalysis) saveAnalysisModel(resolvedAnalysis);
        setAnalysisModel(resolvedAnalysis);
      })
      .catch(() => {
        setLoadError(true);
        setSortModel(savedSort ?? null);
        setAnalysisModel(savedAnalysis ?? null);
      });
  }, []);

  const handleSortChange = (value: string) => {
    const choice = decode(value);
    if (!choice) return;
    setSortModel(choice);
    saveSortModel(choice);
  };

  const handleAnalysisChange = (value: string) => {
    const choice = decode(value);
    if (!choice) return;
    setAnalysisModel(choice);
    saveAnalysisModel(choice);
  };

  const sortDesc = models?.sortModels.find((m) => sameChoice(sortModel, m))?.description;
  const analysisDesc = models?.analysisModels.find((m) => sameChoice(analysisModel, m))?.description;

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost model-settings-btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="model-settings-body"
      >
        ⚙ Model Settings{" "}
        <span aria-hidden="true">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div id="model-settings-body" className="model-settings-body">
          {loadError && (
            <p className="note note-error" style={{ margin: 0, gridColumn: "1 / -1" }}>
              Couldn&rsquo;t load the model list — the app will use its defaults.
            </p>
          )}

          <div className="field">
            <label htmlFor="sort-model">Photo Sorting Model</label>
            {models ? (
              <select
                id="sort-model"
                value={sortModel ? encode(sortModel) : ""}
                onChange={(e) => handleSortChange(e.target.value)}
                className="model-select"
              >
                <ModelOptions options={models.sortModels} />
              </select>
            ) : (
              <select disabled className="model-select">
                <option>Loading…</option>
              </select>
            )}
            {sortDesc && <span className="field-hint model-hint">{sortDesc}</span>}
          </div>

          <div className="field">
            <label htmlFor="analysis-model">Listing Generation Model</label>
            {models ? (
              <select
                id="analysis-model"
                value={analysisModel ? encode(analysisModel) : ""}
                onChange={(e) => handleAnalysisChange(e.target.value)}
                className="model-select"
              >
                <ModelOptions options={models.analysisModels} />
              </select>
            ) : (
              <select disabled className="model-select">
                <option>Loading…</option>
              </select>
            )}
            {analysisDesc && <span className="field-hint model-hint">{analysisDesc}</span>}
          </div>
        </div>
      )}
    </>
  );
}
