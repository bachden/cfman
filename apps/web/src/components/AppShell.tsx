import {
  Activity,
  Code2,
  CloudCog,
  Menu,
  ScrollText,
  Settings,
  Cable as TunnelIcon,
  X
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { AppSettings } from "../types";
import { BRAND_ICON_COMPONENTS, brandFaviconHref } from "./brand-icons";

const navigation = [
  { to: "/", label: "Overview", icon: Activity },
  { to: "/accounts", label: "Accounts", icon: CloudCog },
  { to: "/tunnels", label: "Tunnels", icon: TunnelIcon },
  { to: "/scripts", label: "Scripts", icon: Code2 },
  { to: "/audit", label: "Audit log", icon: ScrollText },
  { to: "/settings", label: "Settings", icon: Settings }
];

export function AppShell({ children, username }: { children: ReactNode; username: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<{ settings: AppSettings }>("/api/settings")
  });
  const branding = data?.settings.branding;
  const BrandIconComponent = branding ? BRAND_ICON_COMPONENTS[branding.icon] : CloudCog;
  useEffect(() => {
    if (!branding) return;
    document.title = `${branding.title} — ${branding.subtitle}`;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = brandFaviconHref(branding.icon);
  }, [branding]);
  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><BrandIconComponent size={21} /></div>
          <div><strong>{branding?.title ?? "cfman"}</strong><span>{branding?.subtitle ?? "Control plane"}</span></div>
          <button className="sidebar-close" type="button" onClick={() => setMenuOpen(false)} aria-label="Close navigation"><X size={19} /></button>
        </div>
        <nav>
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === "/"} onClick={() => setMenuOpen(false)}>
              <Icon size={17} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-user"><span className="avatar">{username.slice(0, 1).toUpperCase()}</span><div><strong>{username}</strong><span>Administrator</span></div></div>
      </aside>
      <div className="main-frame">
        <header className="mobile-header">
          <button className="icon-button" onClick={() => setMenuOpen(true)} aria-label="Open navigation"><Menu size={20} /></button>
          <strong>{branding?.title ?? "cfman"}</strong>
        </header>
        <main>{children}</main>
      </div>
      {menuOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    </div>
  );
}
