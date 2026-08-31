import { useEffect } from "react";
import { AlertTriangle, Cpu, ListPlus, Mic, Plus, RefreshCw, Trash2, Volume2 } from "lucide-react";
import { SetGroup, SetRow } from "../../rows";
import Toggle from "../../../ui/Toggle";
import Select from "../../../ui/Select";
import { useClipdip, type AudioDeviceInfo, type AudioSourceStatus } from "./ClipdipContext";

type AudioSourceKind = "system_loopback" | "microphone" | "process_loopback";
interface AudioSource {
  kind: AudioSourceKind;
  device_id?: string;
  /** Ordered device ids tried when the entry above doesn't start; the
   *  literal "default" means the system default endpoint. */
  fallbacks?: string[];
}

const DEFAULT_DEVICE_VALUE = "__default__";
/** Sentinel the engine accepts inside `fallbacks` for "system default". */
const FALLBACK_DEFAULT = "default";
const DEFAULT_SOURCES: AudioSource[] = [{ kind: "system_loopback" }, { kind: "microphone" }];

function kindIcon(k: AudioSourceKind) {
  if (k === "microphone") return Mic;
  if (k === "process_loopback") return Cpu;
  return Volume2;
}

function kindWords(k: AudioSourceStatus["kind"]) {
  return k === "microphone" ? "Microphone" : "System output";
}

function deviceOptionsFor(kind: AudioSourceKind, devices: AudioDeviceInfo[], defaultValue: string) {
  if (kind === "process_loopback") return [];
  const flow = kind === "microphone" ? "Capture" : "Render";
  const filtered = devices.filter((d) => d.flow === flow);
  const def = filtered.find((d) => d.is_default);
  return [
    {
      value: defaultValue,
      label: "System default",
      hint: def ? `Currently: ${def.friendly_name}` : "Follows Windows default",
    },
    ...filtered.map((d) => ({
      value: d.id,
      label: d.friendly_name,
      hint: d.is_default ? "Default" : undefined,
    })),
  ];
}

/** Append a "(disconnected device)" entry when `value` is a device id that
 *  isn't currently connected, so the select shows the truth instead of a
 *  raw id. */
function withStaleOption(
  opts: { value: string; label: string; hint?: string }[],
  value: string | undefined,
  stale: boolean,
) {
  if (!stale || !value) return opts;
  return [...opts, { value, label: "(disconnected device)", hint: value }];
}

export default function ClipdipAudioSection() {
  const { config, patch, devices, devicesLoading, ensureDevices, refreshDevices, live, running } =
    useClipdip();

  // Device list: lazy fetch on mount, re-scan when the window regains focus.
  useEffect(() => {
    ensureDevices();
    const onFocus = () => refreshDevices();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [ensureDevices, refreshDevices]);

  const loading = !config;
  const sources = (config?.audio?.sources as unknown as AudioSource[] | undefined) ?? DEFAULT_SOURCES;
  type ConfigSources = NonNullable<NonNullable<import("../../../../types/clips").ClipdipConfig["audio"]>["sources"]>;
  const setSources = (next: AudioSource[]) =>
    patch({ audio: { sources: next as unknown as ConfigSources } });

  const update = (idx: number, p: Partial<AudioSource>) =>
    setSources(sources.map((s, i) => (i === idx ? { ...s, ...p } : s)));
  const remove = (idx: number) => setSources(sources.filter((_, i) => i !== idx));
  const add = (kind: AudioSourceKind) => setSources([...sources, { kind }]);

  const setFallback = (idx: number, fbIdx: number, value: string) => {
    const fbs = [...(sources[idx].fallbacks ?? [])];
    fbs[fbIdx] = value;
    update(idx, { fallbacks: fbs });
  };
  const addFallback = (idx: number) =>
    update(idx, { fallbacks: [...(sources[idx].fallbacks ?? []), FALLBACK_DEFAULT] });
  const removeFallback = (idx: number, fbIdx: number) => {
    const fbs = (sources[idx].fallbacks ?? []).filter((_, i) => i !== fbIdx);
    update(idx, { fallbacks: fbs.length ? fbs : undefined });
  };

  const mixDisabled = sources.length < 2;

  // Live engine truth: sources that aren't recording what the user asked
  // for. Only meaningful while the pipeline is up.
  const degraded = running
    ? (live?.audio_sources ?? []).filter((s) => s.missing || s.on_fallback)
    : [];

  return (
    <>
      <SetGroup title="Sources" span2>
        {degraded.length > 0 ? (
          <div className="audio-live-warn" role="alert">
            <AlertTriangle size={14} />
            <div className="audio-live-warn-lines">
              {degraded.map((s) => (
                <div key={`${s.index}-${s.kind}`} className="audio-live-warn-line">
                  {s.missing ? (
                    <>
                      <strong>{kindWords(s.kind)}</strong> is not recording — {s.wanted} isn&apos;t
                      available. Clips have no {s.kind === "microphone" ? "mic" : "game"} audio
                      right now.
                    </>
                  ) : (
                    <>
                      <strong>{kindWords(s.kind)}</strong> is recording {s.using} instead of{" "}
                      {s.wanted}.
                    </>
                  )}
                  {s.missing && sources[s.index] ? (
                    <button
                      type="button"
                      className="btn audio-live-warn-fix"
                      onClick={() => update(s.index, { device_id: undefined })}
                    >
                      Use system default
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <SetRow
          title="Recorded tracks"
          description="Sources record simultaneously, each on its own track"
          stacked
        >
          <div className="audio-sources">
            {sources.map((src, i) => {
              const KindIcon = kindIcon(src.kind);
              const devOpts = deviceOptionsFor(src.kind, devices, DEFAULT_DEVICE_VALUE);
              const knownDevice = devices.find((d) => d.id === src.device_id);
              const stale =
                src.kind !== "process_loopback" && Boolean(src.device_id) && !knownDevice && !devicesLoading;
              const fallbacks = src.fallbacks ?? [];
              return (
                <div key={i} className="audio-source">
                  <div className="audio-source-main">
                    <span className="audio-source-icon">
                      <KindIcon size={13} />
                    </span>
                    <Select
                      value={src.kind}
                      disabled={loading}
                      onChange={(kind) =>
                        update(i, { kind: kind as AudioSourceKind, device_id: undefined, fallbacks: undefined })
                      }
                      options={[
                        { value: "system_loopback", label: "System output", hint: "Game audio, music, calls" },
                        { value: "microphone", label: "Microphone", hint: "Your voice" },
                        { value: "process_loopback", label: "Process loopback", hint: "Audio from one specific app" },
                      ]}
                      width={200}
                      aria-label={`Source ${i + 1} kind`}
                    />
                    <span className="audio-source-index">{String(i + 1).padStart(2, "0")}</span>
                    <button
                      type="button"
                      className="audio-source-remove"
                      title="Remove"
                      disabled={loading}
                      onClick={() => remove(i)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  {src.kind !== "process_loopback" ? (
                    <>
                      <div className="audio-source-device">
                        <span className="audio-source-device-label">
                          {fallbacks.length > 0 ? "1." : "Device"}
                        </span>
                        <Select
                          value={src.device_id ?? DEFAULT_DEVICE_VALUE}
                          disabled={loading}
                          onChange={(v) => update(i, { device_id: v === DEFAULT_DEVICE_VALUE ? undefined : v })}
                          options={withStaleOption(devOpts, src.device_id, stale)}
                          width={280}
                          aria-label={`Source ${i + 1} device`}
                        />
                        {stale ? (
                          <span className="audio-source-warn" title="Device not currently connected">
                            <AlertTriangle size={12} />
                          </span>
                        ) : null}
                      </div>
                      {fallbacks.map((fb, fbIdx) => {
                        const fbStale =
                          fb !== FALLBACK_DEFAULT &&
                          !devices.some((d) => d.id === fb) &&
                          !devicesLoading;
                        return (
                          <div key={fbIdx} className="audio-source-device audio-source-fallback">
                            <span className="audio-source-device-label">{fbIdx + 2}.</span>
                            <Select
                              value={fb}
                              disabled={loading}
                              onChange={(v) => setFallback(i, fbIdx, v)}
                              options={withStaleOption(
                                deviceOptionsFor(src.kind, devices, FALLBACK_DEFAULT),
                                fb,
                                fbStale,
                              )}
                              width={280}
                              aria-label={`Source ${i + 1} fallback ${fbIdx + 1}`}
                            />
                            {fbStale ? (
                              <span className="audio-source-warn" title="Device not currently connected">
                                <AlertTriangle size={12} />
                              </span>
                            ) : null}
                            <button
                              type="button"
                              className="audio-source-remove"
                              title="Remove fallback"
                              disabled={loading}
                              onClick={() => removeFallback(i, fbIdx)}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        );
                      })}
                      <div className="audio-source-fallback-actions">
                        <button
                          type="button"
                          className="btn btn-ghost audio-source-add-fallback"
                          disabled={loading}
                          title="Tried in order when the device above isn't available"
                          onClick={() => addFallback(i)}
                        >
                          <ListPlus size={12} /> Add fallback
                        </button>
                        {fallbacks.length === 0 ? (
                          <span className="audio-source-fallback-hint">
                            Without a fallback, a missing device records silence
                          </span>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <div className="audio-source-note">Targets the focused game window. No device pick needed.</div>
                  )}
                </div>
              );
            })}

            <div className="audio-source-actions">
              <button type="button" className="btn" disabled={loading} onClick={() => add("system_loopback")}>
                <Plus size={12} />
                <Volume2 size={12} /> Add system output
              </button>
              <button type="button" className="btn" disabled={loading} onClick={() => add("microphone")}>
                <Plus size={12} />
                <Mic size={12} /> Add microphone
              </button>
              <div className="audio-source-spacer" />
              <button
                type="button"
                className="btn"
                title="Re-scan audio devices"
                disabled={devicesLoading}
                onClick={() => refreshDevices()}
              >
                <RefreshCw size={12} className={devicesLoading ? "spin" : undefined} /> Refresh
              </button>
            </div>
          </div>
        </SetRow>
      </SetGroup>

      <SetGroup title="Mixing" span2>
        <SetRow
          title="Combined mix track"
          description={
            mixDisabled
              ? "Needs at least two sources"
              : "Adds a first track mixing all sources. Per-source tracks are kept either way."
          }
        >
          <Toggle
            checked={!mixDisabled && config?.audio?.include_mix !== false}
            disabled={loading || mixDisabled}
            onChange={(v) => patch({ audio: { include_mix: v } })}
            aria-label="Combined mix track"
          />
        </SetRow>
      </SetGroup>
    </>
  );
}
