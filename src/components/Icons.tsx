import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 18, ...props }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...props,
  };
}

export function PlayIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function StepBackIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M18 6v12L9 12z" fill="currentColor" stroke="none" />
      <path d="M6 5v14" />
    </svg>
  );
}

export function StepForwardIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 6v12l9-6z" fill="currentColor" stroke="none" />
      <path d="M18 5v14" />
    </svg>
  );
}

export function RewindIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 12a8 8 0 1 0 2.4-5.7" />
      <path d="M4 4v5h5" />
    </svg>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 4v11" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M5 19h14" />
    </svg>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="9" y="9" width="10" height="10" rx="2" />
      <path d="M15 5.5A1.5 1.5 0 0 0 13.5 4H6a2 2 0 0 0-2 2v7.5A1.5 1.5 0 0 0 5.5 15" />
    </svg>
  );
}

export function UploadIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 19V8" />
      <path d="m7.5 12.5 4.5-4.5 4.5 4.5" />
      <path d="M5 5h14" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m5 12.5 4.5 4.5L19 6.5" />
    </svg>
  );
}

export function XIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 4 2.8 20h18.4z" />
      <path d="M12 9.5v4.5" />
      <circle cx="12" cy="17.2" r=".7" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4.3l2.8 1.7" />
    </svg>
  );
}

export function FlagIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 21V4" />
      <path d="M6 5h10l-2 3.5L16 12H6z" />
    </svg>
  );
}

export function LayersIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m12 4 8 4-8 4-8-4z" />
      <path d="m4 12 8 4 8-4" />
      <path d="m4 16 8 4 8-4" />
    </svg>
  );
}

export function FileTextIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M13 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V10z" />
      <path d="M13 4v6h6" />
      <path d="M8.5 14h7M8.5 17h4.5" />
    </svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
