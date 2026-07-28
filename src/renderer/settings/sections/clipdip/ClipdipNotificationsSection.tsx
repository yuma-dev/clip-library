import { useCallback, useState } from "react";
import { CirclePlay, Save } from "lucide-react";
import { SetGroup, SetRow } from "../../rows";
import Toggle from "../../../ui/Toggle";
import Slider from "../../../ui/Slider";
import { useToast } from "../../../ui/Toast";
import { clipdipBridge, useClipdip, usePoll, type NotificationRecord } from "./ClipdipContext";
import { CornerPicker } from "./controls";

export default function ClipdipNotificationsSection() {
  const { config, patch, running } = useClipdip();
  const toast = useToast();
  const loading = !config;
  const notif = config?.notifications;
  const notifEnabled = notif?.enabled !== false;

  const [recDot, setRecDot] = useState(false);
  const previewDisabled = !running || !notifEnabled;

  const test = async (stage: "flow" | "notice" | "rec_on" | "rec_off") => {
    try {
      const r = await clipdipBridge().testOverlay(stage);
      if (!r.ok) toast.show(r.error || "Overlay test failed", "error");
      else if (stage === "rec_on") setRecDot(true);
      else if (stage === "rec_off") setRecDot(false);
    } catch {
      toast.show("Overlay test failed", "error");
    }
  };

  return (
    <>
      <SetGroup title="Notifications" span2>
        <SetRow title="Show notification" description="On-screen overlay when a clip is saved">
          <Toggle
            checked={notifEnabled}
            disabled={loading}
            onChange={(v) => patch({ notifications: { enabled: v } })}
            aria-label="Show notification"
          />
        </SetRow>
        <SetRow title="Play sound">
          <Toggle
            checked={notif?.sound !== false}
            disabled={loading || !notifEnabled}
            onChange={(v) => patch({ notifications: { sound: v } })}
            aria-label="Play sound"
          />
        </SetRow>
        <SetRow title="Position">
          <CornerPicker
            value={String(notif?.corner ?? "top_right")}
            disabled={loading || !notifEnabled}
            onChange={(v) =>
              patch({ notifications: { corner: v as "top_left" | "top_right" | "bottom_left" | "bottom_right" } })
            }
          />
        </SetRow>
        <SetRow title="Auto-dismiss">
          <Slider
            value={Number(notif?.auto_dismiss_secs ?? 10)}
            min={0}
            max={30}
            step={1}
            disabled={loading || !notifEnabled}
            onCommit={(v) => patch({ notifications: { auto_dismiss_secs: v } })}
            format={(v) => (v === 0 ? "Never" : `${v} s`)}
            aria-label="Auto-dismiss"
          />
        </SetRow>
        <SetRow title="Health alerts" description="Warn when capture stalls or the buffer degrades">
          <Toggle
            checked={notif?.health_alerts !== false}
            disabled={loading}
            onChange={(v) => patch({ notifications: { health_alerts: v } })}
            aria-label="Health alerts"
          />
        </SetRow>
      </SetGroup>

      <NotificationHistory running={running} />

      <SetGroup title="Preview" span2>
        <SetRow
          title="Preview on screen"
          description={
            !running
              ? "Available while Clipdip is running"
              : !notifEnabled
                ? "Enable notifications to preview"
                : undefined
          }
        >
          <div className="set-btn-row">
            <button type="button" className="btn" disabled={previewDisabled} onClick={() => void test("flow")}>
              <Save size={14} /> Clip saved
            </button>
            <button type="button" className="btn" disabled={previewDisabled} onClick={() => void test("notice")}>
              <CirclePlay size={14} /> Recording started
            </button>
            <button
              type="button"
              className="btn"
              disabled={previewDisabled}
              onClick={() => void test(recDot ? "rec_off" : "rec_on")}
            >
              <span className={`rec-dot${recDot ? " on" : ""}`} />
              Recording dot
            </button>
          </div>
        </SetRow>
      </SetGroup>
    </>
  );
}

// Recent notifications (health alerts, saves, errors) with timestamps, so
// what an auto-dismissing overlay toast said can be read back later.
function NotificationHistory({ running }: { running: boolean }) {
  const [items, setItems] = useState<NotificationRecord[] | null>(null);
  // An older clipdip binary answers the history command with "unknown
  // command" — show a version hint instead of an eternally empty group.
  const [unsupported, setUnsupported] = useState(false);

  const load = useCallback(() => {
    clipdipBridge()
      .control("get_notification_history")
      .then((r) => {
        if (r.ok && Array.isArray(r.notifications)) {
          setUnsupported(false);
          setItems(r.notifications as NotificationRecord[]);
        } else if (!r.ok && /unknown command/i.test(r.error ?? "")) {
          setUnsupported(true);
        }
      })
      .catch(() => {});
  }, []);
  usePoll(load, 10000, running);

  const fmtTime = (ms: number) => {
    const d = new Date(ms);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return sameDay ? time : `${d.toLocaleDateString([], { day: "2-digit", month: "2-digit" })} ${time}`;
  };

  return (
    <SetGroup title="History" span2>
      <SetRow
        title="Recent notifications"
        description={
          !running
            ? "Available while Clipdip is running"
            : unsupported
              ? "Requires a newer Clipdip version"
              : "Every notice Clipdip has shown, with the full text of health alerts"
        }
      />
      {running && !unsupported && items && items.length > 0 ? (
        <div className="clipdip-notif-history">
          {items.slice(0, 50).map((n, i) => (
            <div key={`${n.at_ms}-${i}`} className={`clipdip-notif-entry kind-${n.kind}`}>
              <span className="clipdip-notif-time">{fmtTime(n.at_ms)}</span>
              <span className="clipdip-notif-text">
                <b>{n.title}</b>
                {n.body ? <span className="clipdip-notif-body"> {n.body}</span> : null}
              </span>
            </div>
          ))}
        </div>
      ) : running && !unsupported && items ? (
        <div className="clipdip-notif-history clipdip-notif-empty">No notifications yet.</div>
      ) : null}
    </SetGroup>
  );
}
