import React from 'react';

interface DeltaLogoProps {
  /** Size in pixels (width & height). Default 24. */
  size?: number;
  /** Override fill color. Defaults to Delta Red #C01933. */
  color?: string;
  className?: string;
}

/**
 * Official Delta Air Lines "Widget" — the 3D dimensional triangle.
 * Based on the Delta brand guidelines (Pantone 187 C, #C01933).
 *
 * The widget consists of three layers:
 * 1. Main red triangle body (upper)
 * 2. White chevron swoosh cutting through the middle
 * 3. Darker maroon shadow section (lower-left) for the 3D effect
 */
export const DeltaLogo: React.FC<DeltaLogoProps> = ({
  size = 24,
  color = '#C01933',
  className,
}) => {
  // Derive the darker shadow color from the base
  const shadowColor = color === '#C01933' ? '#8B1029' : color;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Delta Air Lines"
      role="img"
    >
      {/* Main red triangle — full widget shape */}
      <path
        d="M32 4L4 56H60L32 4Z"
        fill={color}
      />
      {/* Darker shadow — lower-left face for 3D depth */}
      <path
        d="M32 4L4 56L24 56L32 38Z"
        fill={shadowColor}
      />
      {/* White chevron swoosh — cuts through the middle */}
      <path
        d="M18 48L32 30L46 48L40 48L32 36L24 48Z"
        fill="white"
      />
    </svg>
  );
};

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
