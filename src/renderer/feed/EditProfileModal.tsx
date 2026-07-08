// Edit-profile modal — in-app port of the reference website EditProfileModal.tsx.
// Lets the signed-in user set their bio, accent colour, and banner (gradient
// preset OR uploaded image). Reuses the shared `.share-modal-*` styling plus a
// few `.edit-profile-*` extras in profile.css.
//
// Banner image upload differs from the website: instead of threading a File
// through the DOM, "Upload image" invokes the main-process native picker
// (window.clips.shareUploadBanner), which uploads immediately; on success we
// refetch the profile via onSaved.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { updateMyProfile, removeMyBanner, type UpdateProfileBody } from "./api";
import { useToast } from "../ui/Toast";

const GRADIENT_PRESETS: { name: string; css: string }[] = [
  { name: "sunset", css: "linear-gradient(135deg, #ff6b35, #f72585)" },
  { name: "ocean", css: "linear-gradient(135deg, #0077b6, #00b4d8)" },
  { name: "forest", css: "linear-gradient(135deg, #2d6a4f, #52b788)" },
  { name: "galaxy", css: "linear-gradient(135deg, #7209b7, #3a0ca3)" },
  { name: "fire", css: "linear-gradient(135deg, #e63946, #ff6d00)" },
  { name: "midnight", css: "linear-gradient(135deg, #1d3557, #457b9d)" },
  { name: "aurora", css: "linear-gradient(135deg, #06d6a0, #7209b7)" },
  { name: "rose", css: "linear-gradient(135deg, #ff758f, #ff4d6d)" },
];

interface EditProfileModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after the Save button succeeds (closes + refreshes the profile). */
  onSaved: () => void;
  /** Called after a banner upload/remove — refresh the profile, keep the modal open. */
  onRefresh: () => void;
  initialBio: string | null;
  initialAccentColor: string | null;
  initialBannerGradient: string | null;
  initialBannerType: string | null;
}

export default function EditProfileModal({
  open,
  onClose,
  onSaved,
  onRefresh,
  initialBio,
  initialAccentColor,
  initialBannerGradient,
  initialBannerType,
}: EditProfileModalProps) {
  const toast = useToast();
  const [bio, setBio] = useState(initialBio || "");
  const [accentColor, setAccentColor] = useState(initialAccentColor || "");
  const [bannerGradient, setBannerGradient] = useState(initialBannerGradient || "");
  const [bannerType, setBannerType] = useState(initialBannerType || "");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const aliveRef = useRef(true);

  useEffect(() => {
    if (!open) return;
    aliveRef.current = true;
    setBio(initialBio || "");
    setAccentColor(initialAccentColor || "");
    setBannerGradient(initialBannerGradient || "");
    setBannerType(initialBannerType || "");
    setError("");
    return () => {
      aliveRef.current = false;
    };
  }, [open, initialBio, initialAccentColor, initialBannerGradient, initialBannerType]);

  if (!open) return null;

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      const body: UpdateProfileBody = {
        bio: bio || null,
        accentColor: accentColor || null,
      };
      // Only touch the banner gradient when the banner ISN'T an uploaded image.
      // Sending `bannerGradient: null` alongside an image banner makes the server
      // clear the banner entirely (resetting it to the default accent gradient),
      // which wiped the freshly-uploaded image. Omitting the key leaves the
      // uploaded image untouched. Picking a gradient preset flips bannerType to
      // "gradient", so switching image → gradient still works.
      if (bannerType !== "image") {
        body.bannerGradient = bannerGradient || null;
      }
      await updateMyProfile(body);
      if (!aliveRef.current) return;
      toast.show("Profile updated");
      onSaved();
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      if (aliveRef.current) setSaving(false);
    }
  };

  const handleUploadImage = async () => {
    setUploading(true);
    setError("");
    try {
      const res = await window.clips.shareUploadBanner();
      if (!aliveRef.current) return;
      if (res.canceled) return;
      if (res.success) {
        setBannerType("image");
        setBannerGradient("");
        toast.show("Banner uploaded");
        onRefresh();
      } else {
        setError(res.error || "Banner upload failed.");
      }
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : "Banner upload failed.");
    } finally {
      if (aliveRef.current) setUploading(false);
    }
  };

  const handleRemoveBanner = async () => {
    try {
      await removeMyBanner();
      if (!aliveRef.current) return;
      setBannerGradient("");
      setBannerType("");
      toast.show("Banner removed");
      onRefresh();
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : "Failed to remove banner.");
    }
  };

  return createPortal(
    <div
      className="share-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <div className="share-modal edit-profile-modal" role="dialog" aria-label="Edit profile">
        <div className="share-modal-head">
          <h2>Edit Profile</h2>
          <button type="button" className="share-modal-close" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Bio */}
        <label className="share-modal-label" htmlFor="edit-bio">
          Bio <span className="edit-profile-count">{bio.length}/200</span>
        </label>
        <textarea
          id="edit-bio"
          className="share-modal-input edit-profile-textarea"
          value={bio}
          onChange={(e) => setBio(e.target.value.slice(0, 200))}
          maxLength={200}
          rows={3}
          placeholder="Tell people about yourself…"
        />

        {/* Accent colour */}
        <label className="share-modal-label">Accent Color</label>
        <div className="edit-profile-accent">
          <input
            type="color"
            value={accentColor || "#8b5cf6"}
            onChange={(e) => setAccentColor(e.target.value)}
            className="edit-profile-color"
            aria-label="Accent color"
          />
          <code className="edit-profile-hex">{accentColor || "#8b5cf6"}</code>
          {accentColor && (
            <button type="button" className="edit-profile-reset" onClick={() => setAccentColor("")}>
              Reset
            </button>
          )}
        </div>

        {/* Banner */}
        <label className="share-modal-label">Banner</label>
        <div className="edit-profile-gradients">
          {GRADIENT_PRESETS.map((preset) => (
            <button
              key={preset.name}
              type="button"
              className={`edit-profile-gradient${
                bannerGradient === preset.name && bannerType !== "image" ? " selected" : ""
              }`}
              style={{ background: preset.css }}
              title={preset.name}
              onClick={() => {
                setBannerGradient(preset.name);
                setBannerType("gradient");
              }}
            />
          ))}
        </div>
        <div className="edit-profile-banner-actions">
          <button
            type="button"
            className={`share-modal-secondary${bannerType === "image" ? " is-active" : ""}`}
            onClick={() => void handleUploadImage()}
            disabled={uploading}
          >
            {uploading ? "Uploading…" : bannerType === "image" ? "Image uploaded" : "Upload image"}
          </button>
          {(bannerGradient || bannerType) && (
            <button type="button" className="edit-profile-remove" onClick={() => void handleRemoveBanner()}>
              Remove
            </button>
          )}
        </div>

        {error && <p className="share-modal-error">{error}</p>}

        <div className="share-modal-actions">
          <button type="button" className="share-modal-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="share-modal-primary"
            onClick={() => void handleSave()}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
