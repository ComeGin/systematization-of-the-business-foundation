import { redirect } from "next/navigation";

// 入口は実行記録の一覧
export default function HomePage() {
  redirect("/runs");
}
