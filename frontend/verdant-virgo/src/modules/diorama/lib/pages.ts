// ページごとの見せ方（spec §5.1 の右の列・§6.7・H-9）。A（vivid）は動く立体（トップだけ押せる）、B（calm）は静止画、C は模型を出さない。
// showsAvatar はその構図に承認台（代表のアバター）が写るか。写るページは、模型が見えている間、画面の端のアバターを出さない（H-13）。
// サービスの 5 本は、Blender でカメラを置いた後（計画の Task 4）に承認台が写るかを確かめて合わせる。
import type { PageKey, PageView } from "./types";

const view = (
  key: PageKey,
  mode: PageView["mode"],
  focus: PageView["focus"],
  showsAvatar: boolean,
): PageView => ({
  mode,
  focus,
  camera: `cam_${key.replace(":", "_")}`,
  showsAvatar,
});

export const PAGE_VIEWS: Readonly<Record<PageKey, PageView>> = {
  top: view("top", "live-touch", null, true),
  services: view("services", "live-view", null, true),
  "service:environment-setup": view(
    "service:environment-setup",
    "live-view",
    "base",
    false,
  ),
  "service:development": view(
    "service:development",
    "live-view",
    "workshop",
    false,
  ),
  "service:consulting": view(
    "service:consulting",
    "live-view",
    "drafting",
    false,
  ),
  "service:partnership": view(
    "service:partnership",
    "live-view",
    "bridge",
    false,
  ),
  about: view("about", "still", "approval", true),
  pricing: view("pricing", "still", "priceTag", false),
  blog: view("blog", "still", "shelf", false),
  contact: view("contact", "still", "desk", false),
  contactThanks: view("contactThanks", "still", "desk", false),
};
