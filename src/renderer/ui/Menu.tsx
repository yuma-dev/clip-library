import type { ReactNode } from "react";

/**
 * Menu content primitives. Purely presentational — drop inside a <Popover/>
 * (anchored) or a fixed-position wrapper (right-click context menu, Phase 3).
 */

export function MenuList({ children }: { children: ReactNode }) {
  return (
    <div className="menu" role="menu">
      {children}
    </div>
  );
}

interface MenuItemProps {
  children: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

export function MenuItem({ children, icon, danger, disabled, onClick }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`menu-item${danger ? " danger" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="menu-icon">{icon}</span>
      <span className="menu-label">{children}</span>
    </button>
  );
}

export function MenuDivider() {
  return <div className="menu-divider" role="separator" />;
}
