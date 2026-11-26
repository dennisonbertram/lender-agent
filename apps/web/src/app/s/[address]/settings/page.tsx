import { SettingsView } from "@/components/settings/SettingsView";

export default async function SettingsPage({ params }: { params: Promise<{ address: string }> }) {
  return <SettingsView address={(await params).address} />;
}
