import { cn } from "@/lib/utils";

interface SettingRowProps {
  label: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

export function SettingRow({ label, description, children, className }: SettingRowProps) {
  return (
    <div className={cn("flex items-center justify-between gap-6 py-4", className)}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-text">{label}</div>
        {description && (
          <div className="mt-0.5 text-xs text-text-muted leading-relaxed">{description}</div>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

export function SettingSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-surface overflow-hidden">
      <div className="px-5 py-3 border-b border-bg-border bg-bg-raised/50">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-text-muted">{title}</h3>
      </div>
      <div className="px-5 divide-y divide-bg-border">{children}</div>
    </div>
  );
}
