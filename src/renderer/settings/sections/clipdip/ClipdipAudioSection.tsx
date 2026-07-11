import { useEffect } from "react";
import { AlertTriangle, Cpu, Mic, Plus, RefreshCw, Trash2, Volume2 } from "lucide-react";
import { SetGroup, SetRow } from "../../rows";
import Toggle from "../../../ui/Toggle";
import Select from "../../../ui/Select";
import { useClipdip, type AudioDeviceInfo } from "./ClipdipContext";

type AudioSourceKind = "system_loopback" | "microphone" | "process_loopback";
interface AudioSource {
  kind: AudioSourceKind;
  device_id?: string;
}

const DEFAULT_DEVICE_VALUE = "__default__";
const DEFAULT_SOURCES: AudioSource[] = [{ kind: "system_loopback" }, { kind: "microphone" }];

function kindIcon(k: AudioSourceKind) {
  if (k === "microphone") return Mic;
  if (k === "process_loopback") return Cpu;
  return Volume2;
}

function deviceOptionsFor(kind: AudioSourceKind, devices: AudioDeviceInfo[]) {
  if (kind === "process_loopback") return [];
  const flow = kind === "microphone" ? "Capture" : "Render";
  const filtered = devices.filter((d) => d.flow === flow);
  const def = filtered.find((d) => d.is_default);
  return [
    {
      value: DEFAULT_DEVICE_VALUE,
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

export default function ClipdipAudioSection() {
  const { config, patch, devices, devicesLoading, ensureDevices, refreshDevices } = useClipdip();

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

  const mixDisabled = sources.length < 2;

  return (
    <>
      <SetGroup title="Sources" span2>
        <SetRow
          title="Recorded tracks"
          description="Sources record simultaneously, each on its own track"
          stacked
        >
          <div className="audio-sources">
            {sources.map((src, i) => {
              const KindIcon = kindIcon(src.kind);
              const devOpts = deviceOptionsFor(src.kind, devices);
              const knownDevice = devices.find((d) => d.id === src.device_id);
              const stale =
                src.kind !== "process_loopback" && Boolean(src.device_id) && !knownDevice && !devicesLoading;
              return (
                <div key={i} className="audio-source">
                  <div className="audio-source-main">
                    <span className="audio-source-icon">
                      <KindIcon size={13} />
                    </span>
                    <Select
                      value={src.kind}
                      disabled={loading}
                      onChange={(kind) => update(i, { kind: kind as AudioSourceKind, device_id: undefined })}
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
                    <div className="audio-source-device">
                      <span className="audio-source-device-label">Device</span>
                      <Select
                        value={src.device_id ?? DEFAULT_DEVICE_VALUE}
                        disabled={loading}
                        onChange={(v) => update(i, { device_id: v === DEFAULT_DEVICE_VALUE ? undefined : v })}
                        options={
                          stale
                            ? [...devOpts, { value: src.device_id!, label: "(disconnected device)", hint: src.device_id }]
                            : devOpts
                        }
                        width={280}
                        aria-label={`Source ${i + 1} device`}
                      />
                      {stale ? (
                        <span className="audio-source-warn" title="Device not currently connected">
                          <AlertTriangle size={12} />
                        </span>
                      ) : null}
                    </div>
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
