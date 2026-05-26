// Single source of truth for the CADuniQ Manufacturing brand mark.
// The PNG ships with a transparent background so it sits flush on any
// surface. Two pre-processed variants live in /public:
//   • caduniq-logo.png      — dark navy text; for light surfaces.
//   • caduniq-logo-dark.png — same artwork with the navy text recoloured
//                              near-white; for dark surfaces.
// Both <img>s are rendered into the DOM but CSS (`.caduniq-logo-light` /
// `.caduniq-logo-dark` in globals.css) shows exactly one based on the
// `.dark` class on <html>. The swap happens before first paint via the
// NO_FOUC_SCRIPT, so there's no hydration flash. The `display` rule is
// applied via the className, NOT inline — an inline `display: block`
// would have higher specificity than the toggle and both logos would
// render at once.

import Link from "next/link";

type Props = {
  // Rendered pixel height. Width is derived from the PNG's intrinsic
  // aspect ratio via width:auto + object-contain.
  height?: number;
  // When provided, wraps the logo in a Link to the given href.
  href?: string;
  // Override the alt / aria-label (defaults to the product name).
  label?: string;
};

export default function CaduniqLogo({
  height = 56,
  href,
  label = "CADuniQ Manufacturing",
}: Props) {
  // NB: do NOT set `display` here — that's owned by the .caduniq-logo-*
  // CSS classes so the theme toggle can hide one img and show the other.
  const sharedImgStyle: React.CSSProperties = {
    height,
    width: "auto",
    objectFit: "contain",
  };

  const content = (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        height,
        lineHeight: 0,
      }}
    >
      <img
        src="/caduniq-logo.png"
        alt={label}
        className="caduniq-logo-light"
        style={sharedImgStyle}
      />
      <img
        src="/caduniq-logo-dark.png"
        alt={label}
        className="caduniq-logo-dark"
        style={sharedImgStyle}
        aria-hidden
      />
    </span>
  );

  if (href) {
    return (
      <Link
        href={href}
        aria-label={`${label} home`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          textDecoration: "none",
        }}
      >
        {content}
      </Link>
    );
  }
  return content;
}
