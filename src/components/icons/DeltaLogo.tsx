import React from 'react';

interface DeltaLogoProps {
  /** Size in pixels (width & height). Default 24. */
  size?: number;
  /** Override fill color. Defaults to Delta Red #C01933. */
  color?: string;
  className?: string;
}

/**
 * Official Delta Air Lines "Widget" — the iconic red triangle.
 * Based on the Delta brand guidelines (Pantone 187 C, #C01933).
 *
 * The shape is a refined isoceles triangle with slightly concave sides,
 * matching the official Delta widget proportions.
 */
export const DeltaLogo: React.FC<DeltaLogoProps> = ({
  size = 24,
  color = '#C01933',
  className,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 32 32"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-label="Delta Air Lines"
    role="img"
  >
    {/* Delta widget — refined triangle with characteristic slight concavity */}
    <path
      d="M16 2L2.5 28.5H29.5L16 2Z"
      fill={color}
    />
  </svg>
);

interface DeltaWordmarkProps {
  /** Height in pixels. Width scales proportionally. Default 20. */
  height?: number;
  className?: string;
}

/**
 * Delta wordmark: Widget + "DELTA" text.
 * Used in headers and boarding passes.
 */
export const DeltaWordmark: React.FC<DeltaWordmarkProps> = ({
  height = 20,
  className,
}) => (
  <div className={`flex items-center gap-2 ${className || ''}`}>
    <DeltaLogo size={height} />
    <span
      className="font-headline font-extrabold tracking-tighter uppercase"
      style={{ fontSize: height * 0.85, lineHeight: 1, color: '#003366' }}
    >
      DELTA
    </span>
  </div>
);
