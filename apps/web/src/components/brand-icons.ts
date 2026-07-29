import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Cable, Cloud, CloudCog, Globe2, Server, ShieldCheck, Zap, type LucideIcon } from "lucide-react";
import type { BrandIcon } from "../types";

export const BRAND_ICON_OPTIONS: BrandIcon[] = ["cloud-cog", "cloud", "cable", "globe", "shield-check", "server", "zap"];

export const BRAND_ICON_COMPONENTS: Record<BrandIcon, LucideIcon> = {
  "cloud-cog": CloudCog,
  cloud: Cloud,
  cable: Cable,
  globe: Globe2,
  "shield-check": ShieldCheck,
  server: Server,
  zap: Zap
};

// Renders a brand icon to an inline SVG data URI so the browser tab favicon
// can mirror whatever icon is chosen for the sidebar, with no static asset
// to keep in sync.
export function brandFaviconHref(icon: BrandIcon): string {
  const Icon = BRAND_ICON_COMPONENTS[icon];
  const markup = renderToStaticMarkup(createElement(Icon, { color: "#056347", strokeWidth: 2.25 }));
  const svg = markup.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
