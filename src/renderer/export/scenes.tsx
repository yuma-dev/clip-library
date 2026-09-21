// Scene registry for the exporter. A scene mounts one app component into a fixed
// export frame, tagging sub-parts with data-layer so the capture script can peel
// them into separate PNGs. Disposable per-component; clipCard is the reference.

import type { CSSProperties, ReactElement } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, FolderOpen, Maximize, Plus, RotateCcw, Scissors, Search, Tag, Trash2, Upload } from "lucide-react";
import { MenuDivider, MenuItem, MenuList } from "../ui/Menu";
import ClipCard from "../library/ClipCard";
import type { ExportSpec, ClipFixture } from "./types";
import { Media, Glow, mediaPath } from "./media";
import { SettingsScene } from "./settingsScene";
import { UserPopoverContent } from "../ui/UserPopover";
import type { UserProfile } from "../feed/types";
import { filterClips } from "../library/filter";
import RailSearch from "../shell/RailSearch";
import type { UseLibraryFilter } from "../library/useLibraryFilter";
import { HeroScene } from './heroScene';
import { MixerRow, MixerChip, VOLUME_ICON_NORMAL, type MixerTrack } from "./mixerRow";
import { PillPlayerScene } from "./pillPlayerScene";

export type Scene = (spec: ExportSpec) => ReactElement;

function LibrarySearchScene(spec: ExportSpec): ReactElement {
  const clips=spec.fixtures.map(f=>f.clip),query=String(spec.props?.query ?? "");
  const tags={saved:new Set<string>(),temporary:new Set<string>(),isTemporary:false};
  const filteredClips=filterClips(clips,{query,tags,collection:"all",applyTags:false});
  const noop=()=>{};
  const filter:UseLibraryFilter={query,setQuery:noop,collection:"all",setCollection:noop,allTags:["Epic","Favorite"],globalTags:["Epic","Favorite"],tags,selectedCount:2,totalCount:2,toggleTag:noop,focusTag:noop,showAllTags:noop,hideAllTags:noop,clearFocus:noop,addGlobalTag:noop,renameGlobalTag:noop,removeGlobalTag:noop,filteredClips};
  return <div id="export-root" style={{position:"relative",width:1000,height:480,padding:50}}>
    <div data-layer="background" style={{position:"absolute",inset:0,background:spec.background ?? "#050608"}}/>
    <div data-layer="search" style={{position:"relative",width:600,marginBottom:35}}><RailSearch filter={filter} clips={clips}/></div>
    <div className="clip-grid" data-layer="cards" style={{position:"relative",display:"grid",gridTemplateColumns:"repeat(3, 1fr)",gap:18,padding:0}}>
      {filteredClips.map(clip=><ClipCard key={clip.originalName} clip={clip} thumbnailPath={clip.thumbnailPath} grayscaleIcons={false} showNewIndicators={false}/>)}
    </div>
  </div>;
}

function ClipCardScene(spec: ExportSpec): ReactElement {
  const f: ClipFixture | undefined = spec.fixtures[0];
  if (!f) return <div style={{ color: "#fff" }}>clipCard scene: no fixture</div>;
  const width = spec.card?.width ?? 340;
  const overflow = spec.card?.glowOverflow ?? 55;
  return (
    <div id="export-root" style={{ position: "relative", display: "inline-block", padding: overflow }}>
      <div
        data-layer="background"
        style={{ position: "absolute", inset: 0, background: spec.background ?? "#0f0f11" }}
      />
      <div className="clip-grid" style={{ position: "relative", padding: 0, width, zIndex: 2 }}>
        <Glow spec={spec} source="#clip-card-media" width={width} height={width * 9 / 16} />
        <div style={{ position: "relative", zIndex: 2 }}>
          <ClipCard
            clip={f.clip}
            thumbnailPath={mediaPath(spec) ?? null}
            mediaOverlay={<Media spec={spec} id="clip-card-media" playing={!!spec.props?.preview} style={{ position:"absolute", inset:0 }}/>}
            grayscaleIcons={!!spec.props?.grayscaleIcons}
            showNewIndicators={!!spec.props?.showNewIndicators}
          />
        </div>
      </div>
    </div>
  );
}

// Uses the app's card, menu primitives and tag styles; state comes from the recipe.
function ClipTagScene(spec: ExportSpec): ReactElement {
  const view = String(spec.props?.menu ?? "closed");
  const tags = (spec.props?.globalTags ?? ["Highlight", "Favorite", "Share"]) as string[];
  const selected = spec.fixtures[0]?.clip.tags ?? [];
  const width = Number(spec.card?.width ?? 420);
  const left = Number(spec.props?.cardLeft ?? 120), top = Number(spec.props?.cardTop ?? 200);
  const people = spec.fixtures[0]?.gameIcon?.discord?.participants.filter(p => !p.bot) ?? [];
  const personIndex = Number(spec.props?.person ?? -1);
  const person = people[personIndex];
  const profiles = spec.props?.profiles as Record<string, UserProfile> ?? {};
  return <div id="export-root" style={{ position: "relative", width: Number(spec.props?.frameWidth ?? 1000), height: Number(spec.props?.frameHeight ?? 720) }}>
    <div data-layer="background" style={{ position: "absolute", inset: 0, background: spec.background ?? "#111114" }} />
    <div style={{ position:"absolute", left, top }}><Glow spec={spec} source="#card-media" width={width} height={width * 9 / 16} active={Number(spec.props?.hover ?? 0)} /></div>
    <div style={{ position: "absolute", left, top, width, padding: 0, gridTemplateColumns: "1fr" }} className="clip-grid" data-layer="clip">
      <ClipCard clip={spec.fixtures[0].clip} thumbnailPath={mediaPath(spec) ?? null} grayscaleIcons={false} showNewIndicators={false}
        mediaOverlay={<Media id="card-media" spec={spec} playing={!!spec.props?.preview} style={{ position:"absolute", inset:0 }} />}
        nameEditor={spec.props?.renaming ? <input className="clip-name clip-name-edit" value={String(spec.props?.renameDraft ?? "")} readOnly data-select-all={!!spec.props?.selectName} /> : undefined} />
    </div>
    <div data-layer="menu" className="popover" style={{ position: "absolute", left: Number(spec.props?.menuLeft ?? 460), top: Number(spec.props?.menuTop ?? 330), width: 250, visibility: view === "closed" ? "hidden" : "visible", zIndex: 2000 }}>
      {view !== "tags" ? <MenuList>
        <MenuItem icon={<Upload size={15} />}>Export to clipboard</MenuItem>
        <button className="menu-item ctx-submenu" data-cue="manage-tags"><span className="menu-icon"><Tag size={15} /></span><span className="menu-label">Manage tags</span><ChevronRight size={14} /></button>
        <MenuDivider />
        <MenuItem icon={<Scissors size={15} />}>Reset trim</MenuItem>
        <MenuItem icon={<RotateCcw size={15} />}>Reset cached metadata</MenuItem>
        <MenuItem icon={<FolderOpen size={15} />}>Reveal in Explorer</MenuItem>
        <MenuDivider /><MenuItem icon={<Trash2 size={15} />} danger>Delete</MenuItem>
      </MenuList> : <div className="menu ctx-tags">
        <button className="ctx-tags-head"><ChevronLeft size={14} /><span>Manage tags</span></button>
        <div className="ctx-tags-search-row"><label className="ctx-tags-search"><Search size={13} /><input placeholder="Search tags…" value={String(spec.props?.query ?? "")} readOnly /></label><button className="ctx-tags-add" disabled><Plus size={15} /></button></div>
        <div className="ctx-tags-list">{tags.map((tag, i) => <button key={tag} data-cue={`tag-${i}`} className={`ctx-tag-row${selected.includes(tag) ? " checked" : ""}`}><span className="ctx-tag-check">{selected.includes(tag) ? <Check size={12} strokeWidth={3} /> : null}</span><span className="ctx-tag-label">{tag}</span></button>)}</div>
      </div>}
    </div>
    <div data-layer="profile" data-anchor={person ? `.clip-participants .user-popover-anchor:nth-child(${personIndex+1})` : undefined} className="user-popover" style={{ position:"absolute", left:left + width - 155, top:Math.max(25,top - (person && profiles[person.id] ? 160 : 100)), visibility:person ? "visible" : "hidden", zIndex:2500 }}>
      {person ? <UserPopoverContent headName={profiles[person.id]?.displayName || person.nick || person.global_name || person.username} headHandle={profiles[person.id]?.username || person.username} headAvatar={person.avatar_url ?? ""} linkable={!!profiles[person.id]} profile={profiles[person.id]} /> : null}
    </div>
  </div>;
}

function AudioMixerScene(spec: ExportSpec): ReactElement {
  const props = (spec.props ?? {}) as {
    tracks?: MixerTrack[];
    backdrop?: string | null;
    panelWidth?: number;
    pad?: number;
  };
  const tracks = props.tracks ?? [];
  const pad = props.pad ?? 44;
  const width = props.panelWidth ?? 320;
  const visible = tracks.filter((t) => !t.hidden);
  const hidden = tracks.filter((t) => t.hidden);
  const backdrop = spec.media?.thumbnail ?? props.backdrop;
  return (
    <div id="export-root" style={{ position: "relative", display: "inline-block", padding: pad }}>
      <div data-layer="background" style={{ position: "absolute", inset: 0, background: spec.background ?? "#0f0f11", overflow: "hidden" }}>
        {backdrop ? (
          <img
            src={`file://${backdrop}`}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "cover", filter: "blur(28px) brightness(0.5) saturate(1.15)", transform: "scale(1.15)" }}
          />
        ) : null}
      </div>
      <div
        id="audio-tracks-panel"
        data-layer="panel"
        style={{ position: "relative", width, margin: 0, animation: "none" }}
      >
        {hidden.length > 0 ? (
          <div className="mixer__hidden-tray" data-layer="tray">
            {hidden.map((t) => (
              <MixerChip key={t.ordinal} track={t} />
            ))}
          </div>
        ) : null}
        <div className="mixer__tracks">
          {visible.map((t) => (
            <MixerRow key={t.ordinal} track={t} />
          ))}
        </div>
      </div>
    </div>
  );
}

// videoPlayer: clip player overlay (player/VideoPlayer.tsx) as a still; <video>
// replaced by a hi-res thumbnail, controls forced visible, playhead at currentSeconds.

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2,"0")}:${String(s % 60).padStart(2,"0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

function VideoPlayerScene(spec: ExportSpec): ReactElement {
  const props = (spec.props ?? {}) as {
    thumbnail?: string | null;
    title?: string;
    currentSeconds?: number;
    durationSeconds?: number;
    width?: number;
    pad?: number;
    showShare?: boolean;
    trimStart?: number;
    trimEnd?: number;
    video?: string;
    videoOffset?: number;
  };
  const width = props.width ?? 960;
  const pad = props.pad ?? 48;
  const cur = props.currentSeconds ?? 0;
  const dur = props.durationSeconds ?? 0;
  const playedPct = dur > 0 ? Math.max(0, Math.min(1, cur / dur)) * 100 : 50;
  const start = Math.max(0, Math.min(dur, props.trimStart ?? 0));
  const end = Math.max(start, Math.min(dur, props.trimEnd ?? dur));
  const startPct = dur ? start / dur * 100 : 0;
  const endPct = dur ? end / dur * 100 : 100;
  return (
    <div id={String(spec.props?.rootId ?? 'export-root')} style={{ position: "relative", display: "inline-block", width:spec.props?.frameWidth as number | undefined, height:spec.props?.frameHeight as number | undefined, overflow:spec.props?.frameWidth ? "hidden" : undefined }}>
      <div data-layer="background" style={{ position: "absolute", inset: 0, background: spec.background ?? "#0b0b0d" }} />
      <div style={{position:spec.props?.frameWidth ? "absolute" : "relative",padding:pad,width:width+2*pad,transformOrigin:"0 0",transform:`scale(${Number(spec.props?.cameraScale ?? 1)}) translate(${-Number(spec.props?.cameraX ?? 0)}px,${-Number(spec.props?.cameraY ?? 0)}px)`}}>
      <div style={{ position:"absolute", left:pad, top:pad }}><Glow spec={spec} source="#video-player" player width={width} height={width * 9 / 16}/></div>
      <div data-layer="shadow" style={{ position: "absolute", left: pad, top: pad, width, height: width * 9 / 16, borderRadius: 10, boxShadow: "0 0 20px #000" }} />
      {spec.props?.navigation ? <><button id="prev-video" className="video-nav-button" type="button" style={{opacity:1,zIndex:2,left:pad-40,top:pad+width*9/32}}><ChevronLeft size={24}/></button><button id="next-video" className="video-nav-button" type="button" style={{opacity:1,zIndex:2,right:pad-40,top:pad+width*9/32}}><ChevronRight size={24}/></button></> : null}
      <div
        id="fullscreen-player"
        data-layer="card"
        style={{ position: "relative", top: "auto", left: "auto", transform: "none", width, margin: 0, zIndex:3, boxShadow: "none" }}
      >
        <div id="video-container">
          {/* Hi-res thumbnail stands in for the <video> element. */}
          <Media spec={spec} id="video-player" style={{ contain:"none", objectFit:"contain" } as CSSProperties}/>
          <div id="video-controls" className="visible" data-layer="controls">
            <div aria-hidden="true" style={{position:"absolute",left:0,right:0,bottom:0,height:"36%",background:`linear-gradient(transparent, rgba(0,0,0,${Number(spec.props?.controlsShade ?? 0)}))`,pointerEvents:"none"}}/>
            <div id="top-controls">
              <input type="text" id="clip-title" data-layer="title" defaultValue={props.title ?? ""} readOnly />
              <div className="player-actions" data-layer="actions">
                <button id="export-button" type="button" style={{ animation: "none" }}>
                  <Copy size={18} />
                </button>
                {props.showShare !== false ? (
                  <button id="share-button" type="button">
                    <Upload size={18} />
                  </button>
                ) : null}
                <button id="delete-button" type="button">
                  <Trash2 size={18} />
                </button>
              </div>
            </div>
            <div id="bottom-controls">
              <div className="playback-row">
                <div id="volume-container">
                  <button id="volume-button" type="button" dangerouslySetInnerHTML={{ __html: VOLUME_ICON_NORMAL }} />
                  {spec.props?.showMixer ? <div id="audio-tracks-panel" data-layer="panel" style={{ opacity:Number(spec.props?.mixerOpen ?? 1), transform:`scale(${0.55 + Number(spec.props?.mixerOpen ?? 1) * 0.45})` }}><div className="mixer__tracks">{((spec.props?.tracks ?? []) as MixerTrack[]).map(track => <MixerRow key={track.ordinal} track={track}/>)}</div></div> : null}
                </div>
                <div className="playback-right">
                  <div id="speed-container">
                    <button id="speed-button" type="button">
                      <span id="speed-text">1x</span>
                    </button>
                  </div>
                  <button id="fullscreen-button" type="button">
                    <Maximize size={19} />
                  </button>
                </div>
              </div>
              <div id="trim-controls" data-layer="progress">
                <div id="progress-bar-container">
                  <div id="progress-bar" style={{ left: `${startPct}%`, right: "auto", width: `${endPct - startPct}%` }} />
                  <div id="trim-start" style={{ left: `${startPct}%` }} />
                  <div id="trim-end" style={{ left: `${endPct}%`, right: "auto" }} />
                  <div id="playhead" style={{ left: `${playedPct}%` }} />
                </div>
              </div>
              <div className="time-row" data-layer="times">
                <div id="current-time">{fmtTime(cur)}</div>
                <div id="total-time">{fmtTime(dur)}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

export const scenes: Record<string, Scene> = {
  clipCard: ClipCardScene,
  audioMixer: AudioMixerScene,
  videoPlayer: VideoPlayerScene,
  clipTag: ClipTagScene,
  clipWorkflow: ClipTagScene,
  mentions: ClipTagScene,
  mixerPlayer: VideoPlayerScene,
  pillPlayer: PillPlayerScene,
  settings: SettingsScene,
  librarySearch: LibrarySearchScene,
  hero: spec=><HeroScene spec={spec} Player={VideoPlayerScene}/>,
};
