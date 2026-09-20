import type { SVGProps } from 'react';

type DrawnLogoProps = SVGProps<SVGSVGElement> & {
  title?: string;
};

/** A vector mark of a quadcopter assembling itself. */
export function DrawnLogo({ title = 'Drawn 로고', ...props }: DrawnLogoProps) {
  return (
    <svg viewBox="0 0 96 96" role="img" aria-label={title} {...props}>
      <style>{`
        .drawn-logo-body { opacity: 0; transform-origin: 48px 48px; animation: drawn-logo-body 1.35s ease-out both; }
        .drawn-logo-arms { stroke-dasharray: 74; stroke-dashoffset: 74; animation: drawn-logo-arms 1.35s ease-out both; }
        .drawn-logo-props { opacity: 0; transform-origin: 48px 48px; animation: drawn-logo-props 1.35s ease-out both; }
        .drawn-logo-spark { opacity: 0; animation: drawn-logo-spark 1.35s ease-out both; }
        @keyframes drawn-logo-body { 0%, 10% { opacity: 0; transform: scale(.55); } 32%, 100% { opacity: 1; transform: scale(1); } }
        @keyframes drawn-logo-arms { 0%, 22% { stroke-dashoffset: 74; } 58%, 100% { stroke-dashoffset: 0; } }
        @keyframes drawn-logo-props { 0%, 48% { opacity: 0; transform: scale(.4) rotate(-40deg); } 68%, 100% { opacity: 1; transform: scale(1) rotate(0); } }
        @keyframes drawn-logo-spark { 0%, 43% { opacity: 0; } 54%, 72% { opacity: 1; } 84%, 100% { opacity: 0; } }
        @media (prefers-reduced-motion: reduce) { .drawn-logo-body, .drawn-logo-props { opacity: 1; transform: none; animation: none; } .drawn-logo-arms { stroke-dashoffset: 0; animation: none; } .drawn-logo-spark { animation: none; opacity: 0; } }
      `}</style>
      <rect width="96" height="96" rx="25" fill="#3182f6" />
      <g fill="none" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
        <path className="drawn-logo-arms" d="M37 42 25 34m34 8 12-8M37 54 25 62m34-8 12 8" />
      </g>
      <g className="drawn-logo-body" fill="none" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M48 34 60 41v14l-12 7-12-7V41l12-7Z" />
      </g>
      <g className="drawn-logo-props" fill="#3182f6" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="20" cy="31" r="5" /><circle cx="76" cy="31" r="5" />
        <circle cx="20" cy="65" r="5" /><circle cx="76" cy="65" r="5" />
      </g>
      <circle className="drawn-logo-spark" cx="48" cy="48" r="2.5" fill="#d7fbff" />
    </svg>
  );
}
