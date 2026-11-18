import { PageFrame, PageHeading } from "@/components/shell/page-frame";
import { t } from "@/lib/messages";

/** What a member who isn't an admin sees on an admin's page. The server refuses them anyway. */
export const AdminOnly = ({ title }: { readonly title: string }) => (
  <PageFrame crumbs={[{ label: t("shell.organization") }, { label: title }]}>
    <PageHeading title={title} lede={t("common.adminsOnly")} />
  </PageFrame>
);
