import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-all duration-150 disabled:pointer-events-none disabled:opacity-40 select-none",
  {
    variants: {
      variant: {
        default:  "bg-accent text-white hover:bg-accent-hover shadow-glow-sm active:scale-95",
        ghost:    "text-text-muted hover:text-text hover:bg-bg-raised",
        outline:  "border border-bg-border text-text-muted hover:border-accent/50 hover:text-text bg-transparent",
        danger:   "bg-danger/20 text-danger border border-danger/30 hover:bg-danger/30",
        subtle:   "bg-bg-raised text-text-muted hover:text-text hover:bg-bg-border",
      },
      size: {
        sm:   "h-7  px-3 text-xs",
        md:   "h-9  px-4",
        lg:   "h-11 px-6 text-base",
        icon: "h-8  w-8 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  )
);
Button.displayName = "Button";

export { Button, buttonVariants };
