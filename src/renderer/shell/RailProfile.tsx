import { LogIn, LogOut } from "lucide-react";
import { useProfile } from "./useProfile";
import fallbackAvatar from "../../../assets/logo.png";

/**
 * Rail profile card wired to the real ClipLib account (test-share-connection).
 * Connected: avatar + username + a sign-out button. Not connected: a sign-in
 * button that starts the auth flow.
 */
export default function RailProfile() {
  const profile = useProfile();

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
    <div className="rail-profile" data-rail-tip={profile.username}>
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
      <button
        type="button"
        className="rail-logout r-label"
        onClick={profile.disconnect}
        title="Sign out"
        aria-label="Sign out"
      >
        <LogOut size={15} />
      </button>
    </div>
  );
}
