import { EmailView } from "@/components/organization/email-view";
import { t } from "@/lib/messages";

export const metadata = { title: t("shell.email") };

const EmailPage = () => <EmailView />;

export default EmailPage;
