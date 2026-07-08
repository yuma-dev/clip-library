import { Gamepad2 } from "lucide-react";
import { useGamepadConnection } from "../player/gamepad";

/** Titlebar chip shown while a controller is connected (legacy #controller-indicator). */
export default function GamepadIndicator() {
  const { connected, id } = useGamepadConnection();
  if (!connected) return null;
  return (
    <div className="gamepad-indicator" title={`Controller connected: ${id ?? "unknown"}`}>
      <Gamepad2 size={13} />
      <span>Controller</span>
    </div>
  );
}
