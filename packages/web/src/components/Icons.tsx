import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...props }: IconProps & { children: ReactNode }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            {...props}
        >
            {children}
        </svg>
    );
}

export const PlusIcon = (props: IconProps) => <Icon {...props}><path d="M8 3.5v9M3.5 8h9" /></Icon>;
export const SplitRightIcon = (props: IconProps) => <Icon {...props}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M8 3v10" /></Icon>;
export const SplitDownIcon = (props: IconProps) => <Icon {...props}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 8h11" /></Icon>;
export const MaximizeIcon = (props: IconProps) => <Icon {...props}><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" /></Icon>;
export const RestoreIcon = (props: IconProps) => <Icon {...props}><path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5 14 2M6.5 9.5 2 14" /></Icon>;
export const RestartIcon = (props: IconProps) => <Icon {...props}><path d="M13 8a5 5 0 1 1-1.6-3.7" /><path d="M13 2.5v3h-3" /></Icon>;
export const CloseIcon = (props: IconProps) => <Icon {...props}><path d="m4 4 8 8M12 4l-8 8" /></Icon>;
export const LinkIcon = (props: IconProps) => <Icon {...props}><path d="M6.5 9.5 9.5 6.5" /><path d="M7 4.5 8.3 3.2a2.8 2.8 0 0 1 4 4L11 8.5M9 11.5l-1.3 1.3a2.8 2.8 0 0 1-4-4L5 7.5" /></Icon>;
export const ArchiveIcon = (props: IconProps) => <Icon {...props}><rect x="2" y="3" width="12" height="3" rx="1" /><path d="M3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M6.5 9h3" /></Icon>;
export const TrashIcon = (props: IconProps) => <Icon {...props}><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2" /></Icon>;
export const ChevronIcon = (props: IconProps) => <Icon {...props}><path d="m6 4 4 4-4 4" /></Icon>;
export const BellIcon = (props: IconProps) => <Icon {...props}><path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3z" /><path d="M6.5 14h3" /></Icon>;
export const KeyboardIcon = (props: IconProps) => <Icon {...props}><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><path d="M4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M5 9.5h6" /></Icon>;
export const FolderIcon = (props: IconProps) => <Icon {...props}><path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" /></Icon>;
export const StopIcon = (props: IconProps) => <Icon {...props}><rect x="4" y="4" width="8" height="8" rx="1.5" /></Icon>;

export function VoltranMark({ size = 22 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
            <g strokeLinecap="round" strokeWidth="3.4">
                <path d="M6 7l3.4 7.4" stroke="#7aa2f7" />
                <path d="M11 18l2.8 6.2" stroke="#f7768e" />
                <path d="M16 27.2v0" stroke="#e0af68" />
                <path d="M18.2 24.2 21 18" stroke="#9ece6a" />
                <path d="M22.6 14.4 26 7" stroke="#bb9af7" />
            </g>
        </svg>
    );
}
