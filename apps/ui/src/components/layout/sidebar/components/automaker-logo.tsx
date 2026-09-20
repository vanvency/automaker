import type { NavigateOptions } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { useOSDetection } from '@/hooks/use-os-detection';

interface AutomakerLogoProps {
  sidebarOpen: boolean;
  navigate: (opts: NavigateOptions) => void;
}

function getOSAbbreviation(os: string): string {
  switch (os) {
    case 'mac':
      return 'M';
    case 'windows':
      return 'W';
    case 'linux':
      return 'L';
    default:
      return '?';
  }
}

export function AutomakerLogo({ sidebarOpen, navigate }: AutomakerLogoProps) {
  const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
  const { os } = useOSDetection();
  const appMode = import.meta.env.VITE_APP_MODE || '?';
  const versionSuffix = `${getOSAbbreviation(os)}${appMode}`;

  return (
    <div
      className={cn(
        'flex items-center gap-3 titlebar-no-drag cursor-pointer group',
        !sidebarOpen && 'flex-col gap-1'
      )}
      onClick={() => navigate({ to: '/worktrees' })}
      data-testid="logo-button"
    >
      {/* Collapsed logo - only shown when sidebar is closed */}
      <div
        className={cn(
          'relative flex flex-col items-center justify-center rounded-lg gap-0.5',
          sidebarOpen ? 'hidden' : 'flex'
        )}
      >
        <img
          src="/automaker.svg"
          alt="Automaker"
          className="size-8 group-hover:rotate-12 transition-transform duration-300 ease-out"
        />
        <span className="text-[0.625rem] text-muted-foreground leading-none font-medium">
          v{appVersion} {versionSuffix}
        </span>
      </div>

      {/* Expanded logo - shown when sidebar is open */}
      {sidebarOpen && (
        <div className="flex flex-col">
          <div className="flex items-center gap-1">
            <img
              src="/automaker.svg"
              alt="Automaker"
              className="h-8 w-8 lg:h-[36.8px] lg:w-[36.8px] shrink-0 group-hover:rotate-12 transition-transform duration-300 ease-out"
            />
            <span className="font-bold text-foreground text-xl lg:text-[1.7rem] tracking-tight leading-none translate-y-[-2px]">
              automaker<span className="text-brand-500">.</span>
            </span>
          </div>
          <span className="text-[0.625rem] text-muted-foreground leading-none font-medium ml-9 lg:ml-[38.8px]">
            v{appVersion} {versionSuffix}
          </span>
        </div>
      )}
    </div>
  );
}
