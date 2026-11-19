import { NotificationSettingsView } from "@/components/account/notification-settings-view";
import { t } from "@/lib/messages";

export const metadata = { title: t("shell.notifications") };

const NotificationsPage = () => <NotificationSettingsView />;

export default NotificationsPage;
