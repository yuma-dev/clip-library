import { routes, type Route } from "../routes";

interface SidebarProps {
  route: Route;
  onNavigate: (route: Route) => void;
  clipCount: number;
}

// Hynite-style nav rail (patterns from Game Launcher App.tsx `.rail`).
export default function Sidebar({ route, onNavigate, clipCount }: SidebarProps) {
  return (
    <aside className="rail">
      <div className="rail-brand">
        <span className="dia">◇</span>
        <span>CLIPS</span>
      </div>
      <nav className="rail-nav">
        {routes.map(({ id, label, icon: Icon, disabled }) => (
          <button
            key={id}
            type="button"
            className={`rail-item${route === id ? " active" : ""}`}
            disabled={disabled}
            title={disabled ? "Coming soon" : undefined}
            onClick={() => {
              if (!disabled) onNavigate(id);
            }}
          >
            <span className="rail-marker" aria-hidden="true">◇</span>
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
