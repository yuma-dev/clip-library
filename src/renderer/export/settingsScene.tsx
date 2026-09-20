import type { CSSProperties } from "react";
import type { ExportSpec } from "./types";
import { NAV_GROUPS } from "../views/SettingsView";
import { SettingsContext, SETTINGS_DEFAULTS, type AppSettings } from "../settings/SettingsContext";
import AppearanceSection from "../settings/sections/AppearanceSection";
import PlayerSection from "../settings/sections/PlayerSection";
import ExportSection from "../settings/sections/ExportSection";
import ShortcutsSection from "../settings/sections/ShortcutsSection";
import { ToastProvider } from "../ui/Toast";
import { ConfirmProvider } from "../ui/ConfirmDialog";
import { mediaPath } from "./media";

export function SettingsScene(spec: ExportSpec) {
  const section = String(spec.props?.section ?? "appearance");
  const overrides = spec.props?.settings as Partial<AppSettings> ?? {};
  const settings = { ...SETTINGS_DEFAULTS, ...overrides, ambientGlow: { ...SETTINGS_DEFAULTS.ambientGlow, ...overrides.ambientGlow }, cardGlow: { ...SETTINGS_DEFAULTS.cardGlow, ...overrides.cardGlow } };
  const active = NAV_GROUPS.flatMap(g => g.items).find(s => s.id === section)!;
  const sections: Record<string, React.ReactNode> = { appearance:<AppearanceSection />, player:<PlayerSection sampleThumb={mediaPath(spec) ?? null} />, export:<ExportSection />, shortcuts:<ShortcutsSection /> };
  return <div id="export-root" style={{ position:"relative", width:1280, height:960, padding:60 }}>
    <div data-layer="background" style={{ position:"absolute", inset:0, background:spec.background ?? "#101013" }} />
    <SettingsContext.Provider value={{ settings, ready:true, set:async () => true, patch:async () => true, undo:() => false, redo:() => false }}>
      <ToastProvider><ConfirmProvider>
        <div className="settings-view" data-layer="settings" style={{ position:"relative", height:840, background:"#111113", border:"1px solid #ffffff12", borderRadius:16, boxShadow:"0 20px 70px #0008", overflow:"hidden" }}>
          <nav className="settings-nav" data-layer="navigation">
            <div className="settings-nav-title">Settings</div>
            {NAV_GROUPS.map((group,i) => <div className="settings-nav-group" key={i}>
              {group.label ? <div className="settings-nav-label">{group.label}</div> : null}
              {group.items.map(({id,label,icon:Icon}) => <button key={id} data-section={id} className={`settings-nav-item${section === id ? " active" : ""}`}><Icon size={15}/><span>{label}</span></button>)}
            </div>)}
          </nav>
          <div className="settings-content" data-layer="content" style={{ overflow:"hidden" }}>
            <div className="settings-page" key={section} style={{ transform:`translateY(-${Number(spec.props?.scroll ?? 0)}px)` } as CSSProperties}>
              <header className="settings-page-head"><h2 className="settings-page-title">{active.label}</h2><p className="settings-page-blurb">{active.blurb}</p></header>
              {sections[section]}
            </div>
          </div>
        </div>
      </ConfirmProvider></ToastProvider>
    </SettingsContext.Provider>
  </div>;
}
