import React from 'react';

interface CivifixLogoProps {
  className?: string;
  size?: number;
}

export const CivifixLogo: React.FC<CivifixLogoProps> = ({ className = 'w-16 h-16', size }) => {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={size ? { width: size, height: size } : undefined}
    >
      <defs>
        <linearGradient id="leafGrad" x1="20" y1="10" x2="100" y2="110" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#10B981" />
          <stop offset="50%" stopColor="#059669" />
          <stop offset="100%" stopColor="#047857" />
        </linearGradient>
        <linearGradient id="buildingGrad" x1="40" y1="40" x2="80" y2="100" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#064E3B" />
          <stop offset="100%" stopColor="#022C22" />
        </linearGradient>
        <linearGradient id="highlightGrad" x1="10" y1="30" x2="50" y2="90" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#34D399" stopOpacity="0.8" />
          <stop offset="100%" stopColor="#059669" stopOpacity="0.1" />
        </linearGradient>
      </defs>

      {/* Outer Leaf Silhouette Shape */}
      <path
        d="M60 8 C88 8 108 30 108 58 C108 88 84 108 54 112 C32 115 12 100 12 76 C12 40 38 12 60 8 Z"
        fill="url(#leafGrad)"
      />

      {/* Leaf Left Curvature Accent */}
      <path
        d="M26 84 C18 64 26 40 44 24 C34 42 32 66 48 80 C38 83 30 84 26 84 Z"
        fill="url(#highlightGrad)"
      />

      {/* Central Buildings Inside Leaf */}
      {/* Left Tower */}
      <rect x="42" y="52" width="12" height="42" rx="1.5" fill="#FFFFFF" />
      <rect x="45" y="56" width="2.5" height="4" fill="#047857" />
      <rect x="49" y="56" width="2.5" height="4" fill="#047857" />
      <rect x="45" y="64" width="2.5" height="4" fill="#047857" />
      <rect x="49" y="64" width="2.5" height="4" fill="#047857" />
      <rect x="45" y="72" width="2.5" height="4" fill="#047857" />
      <rect x="49" y="72" width="2.5" height="4" fill="#047857" />
      <rect x="45" y="80" width="2.5" height="4" fill="#047857" />
      <rect x="49" y="80" width="2.5" height="4" fill="#047857" />

      {/* Center Tall Tower with angled roof */}
      <path d="M57 40 L69 34 V94 H57 V40 Z" fill="#FFFFFF" />
      <rect x="60" y="42" width="2.5" height="4" fill="#047857" />
      <rect x="64" y="42" width="2.5" height="4" fill="#047857" />
      <rect x="60" y="50" width="2.5" height="4" fill="#047857" />
      <rect x="64" y="50" width="2.5" height="4" fill="#047857" />
      <rect x="60" y="58" width="2.5" height="4" fill="#047857" />
      <rect x="64" y="58" width="2.5" height="4" fill="#047857" />
      <rect x="60" y="66" width="2.5" height="4" fill="#047857" />
      <rect x="64" y="66" width="2.5" height="4" fill="#047857" />
      <rect x="60" y="74" width="2.5" height="4" fill="#047857" />
      <rect x="64" y="74" width="2.5" height="4" fill="#047857" />
      <rect x="60" y="82" width="2.5" height="4" fill="#047857" />
      <rect x="64" y="82" width="2.5" height="4" fill="#047857" />

      {/* Right Tower */}
      <path d="M72 48 L82 48 V94 H72 V48 Z" fill="#FFFFFF" />
      <rect x="75" y="54" width="2.5" height="4" fill="#047857" />
      <rect x="75" y="62" width="2.5" height="4" fill="#047857" />
      <rect x="75" y="70" width="2.5" height="4" fill="#047857" />
      <rect x="75" y="78" width="2.5" height="4" fill="#047857" />

      {/* Small Sprout / Branch Leaf on Right */}
      <path
        d="M84 66 C96 66 102 54 100 44 C90 46 84 56 84 66 Z"
        fill="#34D399"
      />
    </svg>
  );
};

export const CitySkylineIllustration: React.FC<{ className?: string }> = ({ className = 'w-full' }) => {
  return (
    <svg
      viewBox="0 0 400 130"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="skyGrad1" x1="0" y1="50" x2="0" y2="130" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#10B981" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#059669" stopOpacity="0.5" />
        </linearGradient>
        <linearGradient id="skyGrad2" x1="0" y1="20" x2="0" y2="130" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#34D399" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#10B981" stopOpacity="0.8" />
        </linearGradient>
        <linearGradient id="hillGrad" x1="0" y1="60" x2="0" y2="130" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#10B981" />
          <stop offset="100%" stopColor="#047857" />
        </linearGradient>
      </defs>

      {/* Back Layer Skyline */}
      <path
        d="M0 130 V105 H25 V90 H45 V105 H70 V75 H90 V105 H120 V85 H145 V105 H175 V70 H205 V105 H235 V80 H260 V105 H290 V75 H320 V105 H350 V88 H375 V105 H400 V130 Z"
        fill="url(#skyGrad1)"
      />

      {/* Mid Layer Buildings with Windows */}
      <rect x="50" y="75" width="26" height="55" rx="2" fill="#059669" fillOpacity="0.45" />
      <rect x="54" y="80" width="3" height="4" fill="#FFFFFF" fillOpacity="0.7" />
      <rect x="60" y="80" width="3" height="4" fill="#FFFFFF" fillOpacity="0.7" />
      <rect x="66" y="80" width="3" height="4" fill="#FFFFFF" fillOpacity="0.7" />
      <rect x="54" y="88" width="3" height="4" fill="#FFFFFF" fillOpacity="0.7" />
      <rect x="60" y="88" width="3" height="4" fill="#FFFFFF" fillOpacity="0.7" />
      <rect x="66" y="88" width="3" height="4" fill="#FFFFFF" fillOpacity="0.7" />

      <rect x="85" y="60" width="32" height="70" rx="2" fill="#047857" fillOpacity="0.55" />
      <rect x="91" y="68" width="3.5" height="5" fill="#FFFFFF" fillOpacity="0.7" />
      <rect x="99" y="68" width="3.5" height="5" fill="#FFFFFF" fillOpacity="0.7" />
      <rect x="107" y="68" width="3.5" height="5" fill="#FFFFFF" fillOpacity="0.7" />
      <rect x="91" y="78" width="3.5" height="5" fill="#FFFFFF" fillOpacity="0.7" />
      <rect x="99" y="78" width="3.5" height="5" fill="#FFFFFF" fillOpacity="0.7" />
      <rect x="107" y="78" width="3.5" height="5" fill="#FFFFFF" fillOpacity="0.7" />

      <rect x="130" y="70" width="25" height="60" rx="2" fill="#059669" fillOpacity="0.45" />
      <rect x="195" y="65" width="35" height="65" rx="2" fill="#047857" fillOpacity="0.55" />
      <rect x="250" y="72" width="28" height="58" rx="2" fill="#059669" fillOpacity="0.45" />
      <rect x="300" y="62" width="34" height="68" rx="2" fill="#047857" fillOpacity="0.55" />

      {/* Front Rolling Green Hills & Leaves */}
      <path
        d="M-20 130 Q60 85 140 100 Q220 115 300 95 Q370 78 420 130 Z"
        fill="url(#hillGrad)"
        fillOpacity="0.85"
      />
      <path
        d="M-10 130 Q80 102 180 112 Q280 122 410 102 L410 130 Z"
        fill="#047857"
      />

      {/* Stylized Foliage / Leaves at Bottom Edge */}
      <path
        d="M30 118 C20 105 35 95 48 102 C42 112 36 116 30 118 Z"
        fill="#34D399"
      />
      <path
        d="M340 116 C355 102 370 110 365 122 C355 120 348 118 340 116 Z"
        fill="#34D399"
      />
      <path
        d="M362 108 C378 98 388 108 380 120 C372 118 368 112 362 108 Z"
        fill="#10B981"
      />
    </svg>
  );
};
