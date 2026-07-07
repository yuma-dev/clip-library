import { LogIn, LogOut } from "lucide-react";
import { useProfile } from "./useProfile";
import { useAppNav } from "./appNav";
import { fetchMe } from "../feed/me";
import fallbackAvatar from "../../../assets/logo.png";

/**
 * Rail profile card wired to the real ClipLib account (test-share-connection).
 * Connected: avatar + username (clicking opens your own ClipLib profile) + a
 * sign-out button. Not connected: a sign-in button that starts the auth flow.
 */
export default function RailProfile() {
  const profile = useProfile();
  const { openProfile } = useAppNav();

  // Connected: clicking the avatar/name opens the signed-in user's own public
  // ClipLib profile from any route. The sign-out button stops propagation so it
  // never triggers this.
  const openOwnProfile = async () => {
    const me = await fetchMe();
    if (me) openProfile(me.id);
  };

  if (!profile.connected) {
    return (
      <button
        type="button"
        className="rail-profile rail-profile-connect"
        data-rail-tip={profile.verifying ? "Checking…" : "Sign in to ClipLib"}
        onClick={profile.connect}
        disabled={profile.verifying}
      >
        <span className="rail-avatar rail-avatar-empty" aria-hidden="true">
          <LogIn size={15} />
        </span>
        <span className="rail-profile-text r-label">
          <span className="rail-profile-name">
            {profile.verifying ? "Checking…" : "Sign in"}
          </span>
          <span className="rail-profile-sub">{profile.verifying ? "" : "Connect ClipLib"}</span>
        </span>
      </button>
    );
  }

  return (
    <div className="rail-profile rail-profile-connected" data-rail-tip={profile.username}>
      <button
        type="button"
        className="rail-profile-open"
        onClick={openOwnProfile}
        title="Open your ClipLib profile"
        aria-label="Open your ClipLib profile"
      >
        <span className="rail-avatar">
          <img
            src={profile.avatarUrl || fallbackAvatar}
            alt=""
            draggable={false}
            onError={(e) => {
              const img = e.currentTarget;
              if (img.src !== fallbackAvatar) img.src = fallbackAvatar;
            }}
          />
          <span className="rail-avatar-dot" />
        </span>
        <span className="rail-profile-text r-label">
          <span className="rail-profile-name">{profile.username}</span>
        </span>
      </button>
      <button
        type="button"
        className="rail-logout r-label"
        onClick={(e) => {
          e.stopPropagation();
          profile.disconnect();
        }}
        title="Sign out"
        aria-label="Sign out"
      >
        <LogOut size={15} />
      </button>
    </div>
  );
}
