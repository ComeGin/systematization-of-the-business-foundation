// ページごとの冒頭の静止画のカメラ（spec §7）と、パスからページへの対応。
// A（トップ・サービス一覧・詳細）は背景に全面で敷くので Mobile 用の縦長の構図を別に撮る。B は 4:3 の 1 枚を Mobile でも使う。
import type { PageKey, StillView } from "./types";

const view = (
  key: PageKey,
  { mobile = false, showsAvatar = false } = {},
): StillView => ({
  camera: `cam_${key.replace(":", "_")}`,
  showsAvatar,
  mobile,
});

export const STILL_VIEWS: Readonly<Record<PageKey, StillView>> = {
  top: view("top", { mobile: true, showsAvatar: true }),
  services: view("services", { mobile: true }),
  "service:environment-setup": view("service:environment-setup", {
    mobile: true,
  }),
  "service:development": view("service:development", { mobile: true }),
  "service:consulting": view("service:consulting", { mobile: true }),
  "service:partnership": view("service:partnership", { mobile: true }),
  about: view("about", { showsAvatar: true }),
  pricing: view("pricing"),
  blog: view("blog"),
  contact: view("contact"),
  contactThanks: view("contactThanks"),
  accessibility: view("accessibility"),
};

const SERVICE_SLUGS = [
  "environment-setup",
  "development",
  "consulting",
  "partnership",
] as const;

const FIXED: Readonly<Record<string, PageKey>> = {
  "/": "top",
  "/services": "services",
  "/about": "about",
  "/pricing": "pricing",
  "/blog": "blog",
  "/contact": "contact",
  "/contact/thanks": "contactThanks",
  "/accessibility": "accessibility",
};

/** パスを PageKey に直す。アトリエの絵の無いページは null */
export function pageKeyForPath(path: string): PageKey | null {
  if (!path) return null;
  const p = path.replace(/\/+$/, "") || "/";
  const service = /^\/services\/([^/]+)$/.exec(p);
  if (service) {
    const slug = service[1] as (typeof SERVICE_SLUGS)[number];
    return SERVICE_SLUGS.includes(slug) ? `service:${slug}` : null;
  }
  return FIXED[p] ?? null;
}
