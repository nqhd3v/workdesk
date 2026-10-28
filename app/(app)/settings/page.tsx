import { redirect } from "next/navigation";

// "Settings" breadcrumb target; API keys is the only section for now.
export default function SettingsPage() {
  redirect("/settings/api-keys");
}
