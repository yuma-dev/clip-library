import { Star } from "lucide-react";

interface FavoriteStarProps {
  on: boolean;
  onToggle: () => void;
}

/** star at the end of the title pill; state comes from the library list so card and player agree */
export default function FavoriteStar({ on, onToggle }: FavoriteStarProps) {
  const label = on ? "Remove from favorites" : "Add to favorites";
  return (
    <button
      type="button"
      className={`pl-fav${on ? " on" : ""}`}
      aria-label={label}
      aria-pressed={on}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <Star size={13} strokeWidth={2.2} fill={on ? "currentColor" : "none"} />
    </button>
  );
}
