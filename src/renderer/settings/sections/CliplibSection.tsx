// ClipLib account settings — connection status, invite codes, and API tokens.
// Ports the website SettingsPage.tsx (invite + token management) into the
// desktop app's settings shell. Requires an active ClipLib connection; the
// underlying write routes go through the authenticated share API.

import { useCallback, useEffect, useState } from "react";
import { Copy, Check, LogIn, LogOut, Plus, Trash2 } from "lucide-react";
import { SetGroup, SetRow } from "../rows";
import { useProfile } from "../../shell/useProfile";
import { useToast } from "../../ui/Toast";
import {
  fetchInvites,
  createInvite,
  deleteInvite,
  fetchApiTokens,
  createApiToken,
  deleteApiToken,
} from "../../feed/api";
import type { InviteCode, ApiTokenInfo } from "../../feed/types";

function formatDate(date: string): string {
  try {
    return new Date(date).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return date;
  }
}

export default function CliplibSection() {
  const profile = useProfile();
  const toast = useToast();

  const [tokens, setTokens] = useState<ApiTokenInfo[]>([]);
  const [invites, setInvites] = useState<InviteCode[]>([]);
  const [tokenLabel, setTokenLabel] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenLoading, setTokenLoading] = useState(false);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!profile.connected) return;
    fetchApiTokens()
      .then(setTokens)
      .catch(() => {});
    fetchInvites()
      .then(setInvites)
      .catch(() => {});
  }, [profile.connected]);

  useEffect(() => {
    load();
  }, [load]);

  const copyToClipboard = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(id);
    window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
  };

  const generateToken = async () => {
    const label = tokenLabel.trim();
    if (!label) return;
    setTokenLoading(true);
    try {
      const token = await createApiToken(label);
      setNewToken(token);
      setTokenLabel("");
      await fetchApiTokens().then(setTokens).catch(() => {});
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "Failed to create token", "error");
    } finally {
      setTokenLoading(false);
    }
  };

  const revokeToken = async (id: string, label: string) => {
    if (!window.confirm(`Revoke "${label}"? Any app using this token will stop working.`)) return;
    try {
      await deleteApiToken(id);
      setTokens((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "Failed to revoke token", "error");
    }
  };

  const makeInvite = async () => {
    setInviteLoading(true);
    try {
      await createInvite(1);
      await fetchInvites().then(setInvites).catch(() => {});
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "Failed to create invite", "error");
    } finally {
      setInviteLoading(false);
    }
  };

  const removeInvite = async (id: string) => {
    try {
      await deleteInvite(id);
      setInvites((prev) => prev.filter((i) => i.id !== id));
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "Failed to delete invite", "error");
    }
  };

  if (!profile.connected) {
    return (
      <SetGroup title="ClipLib account" span2>
        <SetRow
          title="Not connected"
          description="Sign in to ClipLib to manage invite codes and API tokens."
        >
          <button type="button" className="btn" onClick={profile.connect} disabled={profile.verifying}>
            <LogIn size={14} /> {profile.verifying ? "Checking…" : "Connect ClipLib"}
          </button>
        </SetRow>
      </SetGroup>
    );
  }

  return (
    <>
      <SetGroup title="ClipLib account" span2>
        <SetRow title="Signed in" description={profile.username || "Connected"}>
          <button type="button" className="btn" onClick={profile.disconnect}>
            <LogOut size={14} /> Sign out
          </button>
        </SetRow>
      </SetGroup>

      <SetGroup title="API tokens" span2>
        <SetRow
          title="Create token"
          description="Tokens let the desktop app, bots, or other integrations authenticate. Each works independently."
          stacked
        >
          <div className="cliplib-token-create">
            <input
              type="text"
              className="cliplib-input"
              value={tokenLabel}
              onChange={(e) => setTokenLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void generateToken()}
              placeholder="Token name (e.g. ClipLib Desktop)"
            />
            <button
              type="button"
              className="btn"
              onClick={() => void generateToken()}
              disabled={tokenLoading || !tokenLabel.trim()}
            >
              <Plus size={14} /> {tokenLoading ? "Creating…" : "Create"}
            </button>
          </div>
        </SetRow>

        {newToken && (
          <div className="cliplib-newtoken">
            <code className="cliplib-newtoken-code">{newToken}</code>
            <button
              type="button"
              className="btn"
              onClick={() => void copyToClipboard(newToken, "new-token")}
            >
              {copied === "new-token" ? <Check size={14} /> : <Copy size={14} />}
              {copied === "new-token" ? "Copied!" : "Copy"}
            </button>
            <p className="cliplib-warn">Save this token now — it won't be shown again.</p>
          </div>
        )}

        {tokens.length > 0 ? (
          <div className="cliplib-list">
            {tokens.map((token) => (
              <div key={token.id} className="cliplib-row">
                <div className="cliplib-row-info">
                  <span className="cliplib-row-name">{token.label}</span>
                  <span className="cliplib-row-sub">Created {formatDate(token.createdAt)}</span>
                </div>
                <button
                  type="button"
                  className="cliplib-link danger"
                  onClick={() => void revokeToken(token.id, token.label)}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        ) : (
          !newToken && <p className="cliplib-empty">No tokens yet.</p>
        )}
      </SetGroup>

      <SetGroup title="Invite codes" span2>
        <SetRow title="Invite friends" description="Create invite codes to bring friends onto ClipLib." stacked>
          <button
            type="button"
            className="btn"
            onClick={() => void makeInvite()}
            disabled={inviteLoading}
          >
            <Plus size={14} /> {inviteLoading ? "Creating…" : "Create invite code"}
          </button>
        </SetRow>

        {invites.length > 0 ? (
          <div className="cliplib-list">
            {invites.map((invite) => (
              <div key={invite.id} className="cliplib-row">
                <div className="cliplib-row-info">
                  <code className="cliplib-code">{invite.code}</code>
                  <span className="cliplib-row-sub">
                    {invite.uses}/{invite.maxUses} used
                  </span>
                </div>
                <div className="cliplib-row-actions">
                  <button
                    type="button"
                    className="cliplib-link"
                    onClick={() => void copyToClipboard(invite.code, invite.id)}
                  >
                    {copied === invite.id ? "Copied!" : "Copy"}
                  </button>
                  {invite.uses === 0 && (
                    <button
                      type="button"
                      className="cliplib-link danger"
                      onClick={() => void removeInvite(invite.id)}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="cliplib-empty">No invite codes yet.</p>
        )}
      </SetGroup>
    </>
  );
}
