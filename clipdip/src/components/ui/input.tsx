import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "w-full rounded-lg border border-bg-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-faint",
      "transition-colors focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/50",
      "disabled:opacity-40",
      className
    )}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
