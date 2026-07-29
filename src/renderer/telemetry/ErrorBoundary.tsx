import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from "react";
import { framesOf, reportEvent } from "./index";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  crashed: boolean;
}

/** First frame of React's component stack, e.g. "LibraryView". */
function componentNameOf(componentStack: string | null | undefined): string {
  try {
    const first = (componentStack ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    const match = first ? /^(?:at\s+)?([A-Za-z0-9_$.]+)/.exec(first) : null;
    return match?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

const backdrop: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 9999,
  display: "grid",
  placeItems: "center",
  background: "var(--color-bg-primary, #050608)",
  color: "var(--color-text-primary, #f4f4f6)",
  fontFamily: "var(--app-font-family, system-ui, sans-serif)",
};

const panel: CSSProperties = {
  maxWidth: 340,
  padding: 24,
  textAlign: "center",
};

const heading: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
};

const body: CSSProperties = {
  margin: "8px 0 20px",
  fontSize: 13,
  lineHeight: 1.5,
  color: "var(--color-text-secondary, rgba(255,255,255,0.56))",
};

const action: CSSProperties = {
  padding: "8px 20px",
  fontSize: 13,
  fontWeight: 500,
  fontFamily: "inherit",
  color: "#fff",
  background: "var(--color-accent, #8e329b)",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
};

/**
 * Catches render-phase throws, which used to unmount the whole tree to a blank
 * window with nothing in the log. The fallback is styled inline on purpose: it
 * has to render even when whatever broke took the stylesheet's markup with it.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { crashed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportEvent("js_render_crash", {
      kind: "crash",
      severity: "fatal",
      error,
      context: {
        component: componentNameOf(info.componentStack),
        frames: framesOf(error),
      },
    });
  }

  render(): ReactNode {
    if (!this.state.crashed) return this.props.children;
    return (
      <div style={backdrop}>
        <div style={panel}>
          <h2 style={heading}>This view crashed</h2>
          <p style={body}>Reloading usually brings it back.</p>
          <button type="button" style={action} onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
