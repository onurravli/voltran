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
export const SidebarIcon = (props: IconProps) => <Icon {...props}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M6.5 3v10" /></Icon>;
export const SplitDownIcon = (props: IconProps) => <Icon {...props}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 8h11" /></Icon>;
export const MaximizeIcon = (props: IconProps) => <Icon {...props}><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" /></Icon>;
export const RestoreIcon = (props: IconProps) => <Icon {...props}><path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5 14 2M6.5 9.5 2 14" /></Icon>;
export const RestartIcon = (props: IconProps) => <Icon {...props}><path d="M13 8a5 5 0 1 1-1.6-3.7" /><path d="M13 2.5v3h-3" /></Icon>;
export const CloseIcon = (props: IconProps) => <Icon {...props}><path d="m4 4 8 8M12 4l-8 8" /></Icon>;
export const LinkIcon = (props: IconProps) => <Icon {...props}><path d="M6.5 9.5 9.5 6.5" /><path d="M7 4.5 8.3 3.2a2.8 2.8 0 0 1 4 4L11 8.5M9 11.5l-1.3 1.3a2.8 2.8 0 0 1-4-4L5 7.5" /></Icon>;
export const ChevronIcon = (props: IconProps) => <Icon {...props}><path d="m6 4 4 4-4 4" /></Icon>;
export const ChevronUpIcon = (props: IconProps) => <Icon {...props}><path d="m4 10 4-4 4 4" /></Icon>;
export const ChevronDownIcon = (props: IconProps) => <Icon {...props}><path d="m4 6 4 4 4-4" /></Icon>;
export const BellIcon = (props: IconProps) => <Icon {...props}><path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3z" /><path d="M6.5 14h3" /></Icon>;
export const KeyboardIcon = (props: IconProps) => <Icon {...props}><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><path d="M4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M5 9.5h6" /></Icon>;
export const FeedbackIcon = (props: IconProps) => <Icon {...props}><path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z" /><path d="M8 5.5V8M8 9.5h.01" /></Icon>;
export const FolderIcon = (props: IconProps) => <Icon {...props}><path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" /></Icon>;
export const BranchIcon = (props: IconProps) => <Icon {...props}><circle cx="5" cy="3.5" r="1.5" /><circle cx="5" cy="12.5" r="1.5" /><circle cx="11" cy="5.5" r="1.5" /><path d="M5 5v6M11 7c0 2.5-6 1.5-6 4" /></Icon>;
export const NotesIcon = (props: IconProps) => <Icon {...props}><path d="M4 2.5h5.5L12 5v8.5H4z" /><path d="M6 7.5h4M6 10h4" /></Icon>;
export const StopIcon = (props: IconProps) => <Icon {...props}><rect x="4" y="4" width="8" height="8" rx="1.5" /></Icon>;
export const SearchIcon = (props: IconProps) => <Icon {...props}><circle cx="7" cy="7" r="4.25" /><path d="m10.2 10.2 3.3 3.3" /></Icon>;
export const MoreIcon = (props: IconProps) => <Icon {...props} strokeWidth={2.2}><path d="M3.5 8h.01M8 8h.01M12.5 8h.01" /></Icon>;

const MARK_STROKES = [
    { d: 'M6 7l3.4 7.4', from: '-7px, -9px' },
    { d: 'M11 18l2.8 6.2', from: '-6px, -4px' },
    { d: 'M18.2 24.2 21 18', from: '6px, -4px' },
    { d: 'M22.6 14.4 26 7', from: '7px, -9px' },
    { d: 'M16 27.2v0', from: '0px, 6px' },
];

// The five strokes fly in from around the V and lock together, once, when the mark first appears.
export function VoltranMark({ size = 22, form = false }: { size?: number; form?: boolean }) {
    return (
        <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={form ? 'mark mark--form' : 'mark'}>
            <g stroke="currentColor" strokeLinecap="round" strokeWidth="3.4">
                {MARK_STROKES.map((stroke, index) => (
                    <path
                        key={stroke.d}
                        d={stroke.d}
                        style={{ '--from': stroke.from, '--order': index } as React.CSSProperties}
                    />
                ))}
            </g>
        </svg>
    );
}
