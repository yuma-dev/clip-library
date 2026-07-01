import { routes, type Route } from "../routes";
import { useToast } from "../ui/Toast";
import logoUrl from "../../../assets/title.png";

interface SidebarProps {
  route: Route;
  onNavigate: (route: Route) => void;
  clipCount: number;
}

// Nav rail — structure from Hynite's `.rail`, styled per D10 (dark, ◇ accent).
export default function Sidebar({ route, onNavigate, clipCount }: SidebarProps) {
  const toast = useToast();
  return (
    <aside className="rail">
      <div className="rail-brand">
        <img className="rail-logo" src={logoUrl} alt="Clips" draggable={false} />
      </div>
      <nav className="rail-nav">
        {routes.map(({ id, label, icon: Icon, disabled }) => (
          <button
            key={id}
            type="button"
            className={`rail-item${route === id ? " active" : ""}${disabled ? " soon" : ""}`}
            onClick={() => {
              if (disabled) toast.show(`${label} is coming soon`);
              else onNavigate(id);
            }}
          >
            <Icon size={17} />
            <span className="rail-label">{label}</span>
            {id === "library" ? <span className="rail-count-pill">{clipCount}</span> : null}
            {disabled ? <span className="rail-soon">soon</span> : null}
          </button>
        ))}
      </nav>
    </aside>
  );
}
